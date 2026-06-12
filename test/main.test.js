const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const plugin = vm.runInNewContext(
    `${source}\n;({ recognize, resolveConfig, buildEndpoint, buildHeaders, buildRequest, extractText, sanitizeOutput, formatHttpError })`,
    { URL }
);

test("resolveConfig applies MiMo defaults while preserving the API key", () => {
    const config = plugin.resolveConfig({ apiKey: " secret " });

    assert.deepEqual({ ...config }, {
        authType: "api-key",
        baseUrl: "https://api.xiaomimimo.com/v1",
        apiKey: "secret",
        model: "mimo-v2.5",
        customPrompt: ""
    });
});

test("buildEndpoint normalizes supported URL forms", () => {
    assert.equal(plugin.buildEndpoint("https://example.com"), "https://example.com/v1/chat/completions");
    assert.equal(plugin.buildEndpoint("https://example.com/v1/"), "https://example.com/v1/chat/completions");
    assert.equal(
        plugin.buildEndpoint("https://example.com/v1/chat/completions"),
        "https://example.com/v1/chat/completions"
    );
    assert.equal(
        plugin.buildEndpoint("https://example.com/gateway"),
        "https://example.com/gateway/v1/chat/completions"
    );
    assert.throws(() => plugin.buildEndpoint("file:///tmp/api"), (error) => error === "Invalid baseUrl");
});

test("buildHeaders supports api-key, Bearer, and unauthenticated APIs", () => {
    assert.deepEqual({ ...plugin.buildHeaders("api-key", "mimo-key") }, {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "api-key": "mimo-key"
    });
    assert.deepEqual({ ...plugin.buildHeaders("bearer", "openai-key") }, {
        "Content-Type": "application/json",
        "Accept": "application/json",
        Authorization: "Bearer openai-key"
    });
    assert.deepEqual({ ...plugin.buildHeaders("none", "") }, {
        "Content-Type": "application/json",
        "Accept": "application/json"
    });
});

test("recognize sends a MiMo-compatible multimodal request", async () => {
    let capturedUrl;
    let capturedOptions;
    const result = await plugin.recognize("aW1hZ2U=", "Simplified Chinese", {
        config: { apiKey: "mimo-key" },
        utils: {
            tauriFetch: async (url, options) => {
                capturedUrl = url;
                capturedOptions = options;
                return {
                    ok: true,
                    status: 200,
                    data: {
                        choices: [{ message: { content: "第一段。\n\n- 列表项", reasoning_content: "ignored" } }]
                    }
                };
            }
        }
    });

    assert.equal(capturedUrl, "https://api.xiaomimimo.com/v1/chat/completions");
    assert.equal(capturedOptions.method, "POST");
    assert.equal(capturedOptions.headers["api-key"], "mimo-key");
    assert.equal(capturedOptions.body.type, "Json");
    assert.equal(capturedOptions.body.payload.model, "mimo-v2.5");
    assert.equal(capturedOptions.body.payload.max_completion_tokens, 4096);
    assert.equal(
        capturedOptions.body.payload.messages[1].content[0].image_url.url,
        "data:image/png;base64,aW1hZ2U="
    );
    assert.match(capturedOptions.body.payload.messages[1].content[1].text, /Simplified Chinese/);
    assert.equal(result, "第一段。\n\n- 列表项");
});

test("recognize uses custom prompt and Bearer authentication", async () => {
    let request;
    await plugin.recognize("aW1hZ2U=", "auto", {
        config: {
            authType: "bearer",
            baseUrl: "https://vision.example/v1",
            apiKey: "secret",
            model: "vision-model",
            customPrompt: "Return exact text only."
        },
        utils: {
            tauriFetch: async (_url, options) => {
                request = options;
                return { ok: true, status: 200, data: { choices: [{ message: { content: "text" } }] } };
            }
        }
    });

    assert.equal(request.headers.Authorization, "Bearer secret");
    assert.equal(request.body.payload.messages[0].content, "Return exact text only.");
    assert.match(request.body.payload.messages[1].content[1].text, /automatically/);
});

test("recognize permits an API without authentication", async () => {
    let headers;
    const text = await plugin.recognize("aW1hZ2U=", "English", {
        config: {
            authType: "none",
            baseUrl: "http://127.0.0.1:8080/v1",
            model: "local-vision"
        },
        utils: {
            tauriFetch: async (_url, options) => {
                headers = options.headers;
                return { ok: true, status: 200, data: { choices: [{ message: { content: "local text" } }] } };
            }
        }
    });

    assert.equal(headers.Authorization, undefined);
    assert.equal(headers["api-key"], undefined);
    assert.equal(text, "local text");
});

test("extractText accepts empty text and strips only a whole-result code fence", () => {
    assert.equal(plugin.extractText({ choices: [{ message: { content: "" } }] }), "");
    assert.equal(
        plugin.extractText({ choices: [{ message: { content: "```text\nline 1\nline 2\n```" } }] }),
        "line 1\nline 2"
    );
    assert.equal(plugin.sanitizeOutput("value with `code`"), "value with `code`");
});

test("recognize rejects missing API key for authenticated requests", async () => {
    await assert.rejects(
        () => plugin.recognize("aW1hZ2U=", "auto", { config: {}, utils: { tauriFetch: async () => ({}) } }),
        (error) => typeof error === "string" && error.includes("缺少 API Key")
    );
});

test("recognize classifies authentication and image-size errors", async () => {
    await assert.rejects(
        () => plugin.recognize("aW1hZ2U=", "auto", {
            config: { apiKey: "wrong" },
            utils: {
                tauriFetch: async () => ({
                    ok: false,
                    status: 401,
                    data: { error: { message: "invalid api key" } }
                })
            }
        }),
        (error) => typeof error === "string" && error.includes("API 鉴权失败")
    );

    assert.match(
        plugin.formatHttpError("https://example.com/v1/chat/completions", 413, { error: { message: "payload too large" } }),
        /图片或请求体过大/
    );
});

test("formatHttpError classifies model, endpoint, rate-limit, and server failures", () => {
    const endpoint = "https://example.com/v1/chat/completions";

    assert.match(
        plugin.formatHttpError(endpoint, 400, { error: { code: "model_not_found", message: "model not found" } }),
        /模型不可用/
    );
    assert.match(plugin.formatHttpError(endpoint, 404, { error: { message: "not found" } }), /接口地址不存在/);
    assert.match(plugin.formatHttpError(endpoint, 429, { error: { message: "rate limit" } }), /请求过于频繁/);
    assert.match(plugin.formatHttpError(endpoint, 503, { error: { message: "unavailable" } }), /服务暂时不可用/);
});

test("recognize reports an unexpected response structure", async () => {
    await assert.rejects(
        () => plugin.recognize("aW1hZ2U=", "auto", {
            config: { apiKey: "key" },
            utils: { tauriFetch: async () => ({ ok: true, status: 200, data: { output: "text" } }) }
        }),
        (error) => typeof error === "string" && error.includes("API 返回格式异常")
    );
});
