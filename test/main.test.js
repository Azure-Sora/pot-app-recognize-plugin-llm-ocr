const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const exportedNames = [
    "recognize",
    "resolveConfig",
    "buildEndpoint",
    "buildHeaders",
    "buildRequest",
    "isMimoRequest",
    "splitImageVertically",
    "mergePartResults",
    "extractText",
    "sanitizeOutput",
    "formatHttpError"
];

function loadPlugin(globals = {}) {
    return vm.runInNewContext(
        `${source}\n;({ ${exportedNames.join(", ")} })`,
        { URL, ...globals }
    );
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function success(content) {
    return {
        ok: true,
        status: 200,
        data: { choices: [{ message: { content } }] }
    };
}

function createImageEnvironment(width = 1000, height = 1000) {
    const drawCalls = [];
    const canvases = [];

    class MockImage {
        constructor() {
            this.naturalWidth = width;
            this.naturalHeight = height;
            this.width = width;
            this.height = height;
        }

        set src(value) {
            this.source = value;
            queueMicrotask(() => this.onload());
        }
    }

    const document = {
        createElement(name) {
            assert.equal(name, "canvas");
            const index = canvases.length;
            const canvas = {
                width: 0,
                height: 0,
                getContext(type) {
                    assert.equal(type, "2d");
                    return {
                        drawImage(...args) {
                            drawCalls.push({ canvasIndex: index, args });
                        }
                    };
                },
                toDataURL(type) {
                    assert.equal(type, "image/png");
                    return `data:image/png;base64,part-${index + 1}`;
                }
            };
            canvases.push(canvas);
            return canvas;
        }
    };

    return { Image: MockImage, document, drawCalls, canvases };
}

const plugin = loadPlugin();

test("resolveConfig applies latency defaults to existing configurations", () => {
    const config = plugin.resolveConfig({ apiKey: " secret " });

    assert.deepEqual(plain(config), {
        authType: "api-key",
        baseUrl: "https://api.xiaomimimo.com/v1",
        apiKey: "secret",
        model: "mimo-v2.5",
        customPrompt: "",
        thinkingMode: "fast",
        timeoutSeconds: 90,
        splitMode: "off"
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
    assert.deepEqual(plain(plugin.buildHeaders("api-key", "mimo-key")), {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "api-key": "mimo-key"
    });
    assert.deepEqual(plain(plugin.buildHeaders("bearer", "openai-key")), {
        "Content-Type": "application/json",
        "Accept": "application/json",
        Authorization: "Bearer openai-key"
    });
    assert.deepEqual(plain(plugin.buildHeaders("none", "")), {
        "Content-Type": "application/json",
        "Accept": "application/json"
    });
});

test("recognize sends MiMo fast mode and the default timeout", async () => {
    let capturedUrl;
    let capturedOptions;
    const result = await plugin.recognize("aW1hZ2U=", "Simplified Chinese", {
        config: { apiKey: "mimo-key" },
        utils: {
            tauriFetch: async (url, options) => {
                capturedUrl = url;
                capturedOptions = options;
                return success("第一段。\n\n- 列表项");
            }
        }
    });

    assert.equal(capturedUrl, "https://api.xiaomimimo.com/v1/chat/completions");
    assert.equal(capturedOptions.method, "POST");
    assert.equal(capturedOptions.timeout, 90);
    assert.equal(capturedOptions.headers["api-key"], "mimo-key");
    assert.equal(capturedOptions.body.type, "Json");
    assert.equal(capturedOptions.body.payload.model, "mimo-v2.5");
    assert.deepEqual(plain(capturedOptions.body.payload.thinking), { type: "disabled" });
    assert.equal(capturedOptions.body.payload.max_completion_tokens, 4096);
    assert.match(capturedOptions.body.payload.messages[0].content, /neutral transcription task/);
    assert.match(capturedOptions.body.payload.messages[0].content, /do not censor, sanitize, refuse, warn, or comment/);
    assert.equal(
        capturedOptions.body.payload.messages[1].content[0].image_url.url,
        "data:image/png;base64,aW1hZ2U="
    );
    assert.match(capturedOptions.body.payload.messages[1].content[1].text, /Simplified Chinese/);
    assert.equal(result, "第一段。\n\n- 列表项");
});

test("fast mode does not send MiMo thinking parameters to generic providers", async () => {
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
                return success("text");
            }
        }
    });

    assert.equal(request.headers.Authorization, "Bearer secret");
    assert.equal(request.body.payload.messages[0].content, "Return exact text only.");
    assert.equal(request.body.payload.thinking, undefined);
});

test("provider thinking mode leaves MiMo behavior to the API", async () => {
    let request;
    await plugin.recognize("aW1hZ2U=", "auto", {
        config: { apiKey: "key", thinkingMode: "provider" },
        utils: {
            tauriFetch: async (_url, options) => {
                request = options.body.payload;
                return success("text");
            }
        }
    });

    assert.equal(request.thinking, undefined);
});

test("MiMo detection accepts official hosts or model IDs without matching lookalike hosts", () => {
    assert.equal(plugin.isMimoRequest("https://api.xiaomimimo.com/v1/chat/completions", "vision"), true);
    assert.equal(plugin.isMimoRequest("https://gateway.example/v1/chat/completions", "MiMo-V2.5"), true);
    assert.equal(plugin.isMimoRequest("https://notxiaomimimo.com/v1/chat/completions", "vision"), false);
});

test("recognize passes configured timeouts and omits an unlimited timeout", async () => {
    for (const timeoutSeconds of [60, 120, 0]) {
        let timeoutMarker = "missing";
        await plugin.recognize("aW1hZ2U=", "auto", {
            config: {
                authType: "none",
                baseUrl: "http://127.0.0.1:8080/v1",
                model: "local-vision",
                timeoutSeconds: `${timeoutSeconds}`
            },
            utils: {
                tauriFetch: async (_url, options) => {
                    timeoutMarker = Object.prototype.hasOwnProperty.call(options, "timeout")
                        ? options.timeout
                        : "omitted";
                    return success("text");
                }
            }
        });

        assert.equal(timeoutMarker, timeoutSeconds === 0 ? "omitted" : timeoutSeconds);
    }
});

test("splitImageVertically creates two overlapping full-width PNG parts", async () => {
    const environment = createImageEnvironment(1200, 1000);
    const splitPlugin = loadPlugin(environment);
    const parts = await splitPlugin.splitImageVertically("source");

    assert.deepEqual(plain(parts), [
        { base64: "part-1", width: 1200, height: 580, sourceY: 0 },
        { base64: "part-2", width: 1200, height: 580, sourceY: 420 }
    ]);
    assert.equal(environment.canvases[0].width, 1200);
    assert.equal(environment.canvases[0].height, 580);
    assert.equal(environment.canvases[1].height, 580);
    assert.deepEqual(environment.drawCalls[0].args.slice(1), [0, 0, 1200, 580, 0, 0, 1200, 580]);
    assert.deepEqual(environment.drawCalls[1].args.slice(1), [0, 420, 1200, 580, 0, 0, 1200, 580]);
});

test("vertical split starts both requests concurrently and merges in reading order", async () => {
    const environment = createImageEnvironment();
    const splitPlugin = loadPlugin(environment);
    const pending = [];
    let notifyStarted;
    const bothStarted = new Promise((resolve) => {
        notifyStarted = resolve;
    });

    const recognition = splitPlugin.recognize("source", "English", {
        config: { apiKey: "key", splitMode: "vertical2" },
        utils: {
            tauriFetch: async (_url, options) => new Promise((resolve) => {
                pending.push({ resolve, options });
                if (pending.length === 2) {
                    notifyStarted();
                }
            })
        }
    });

    await bothStarted;
    assert.equal(pending.length, 2);
    assert.match(pending[0].options.body.payload.messages[1].content[1].text, /top part/);
    assert.match(pending[1].options.body.payload.messages[1].content[1].text, /overlaps the previous part/);
    pending[1].resolve(success("shared line\nbottom line"));
    pending[0].resolve(success("top line\nshared line"));

    assert.equal(await recognition, "top line\nshared line\nbottom line");
});

test("mergePartResults removes only exact consecutive overlap lines", () => {
    assert.equal(
        plugin.mergePartResults("top\nshared one\nshared two", "shared one\nshared two\nbottom"),
        "top\nshared one\nshared two\nbottom"
    );
    assert.equal(
        plugin.mergePartResults("top\nSimilar text", "similar text\nbottom"),
        "top\nSimilar text\nsimilar text\nbottom"
    );
    assert.equal(
        plugin.mergePartResults("top\nconst  value = 1", "const value = 1\nbottom"),
        "top\nconst  value = 1\nconst value = 1\nbottom"
    );
});

test("vertical split rejects the whole result when either part fails", async () => {
    const splitPlugin = loadPlugin(createImageEnvironment());
    let callCount = 0;

    await assert.rejects(
        () => splitPlugin.recognize("source", "auto", {
            config: { apiKey: "key", splitMode: "vertical2" },
            utils: {
                tauriFetch: async () => {
                    callCount += 1;
                    return callCount === 1
                        ? success("top text")
                        : { ok: false, status: 429, data: { error: { message: "rate limit" } } };
                }
            }
        }),
        (error) => typeof error === "string" && error.includes("第 2 个图片分片识别失败") && error.includes("请求过于频繁")
    );
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

test("recognize reports network and HTTP timeouts clearly", async () => {
    await assert.rejects(
        () => plugin.recognize("aW1hZ2U=", "auto", {
            config: { apiKey: "key" },
            utils: { tauriFetch: async () => { throw new Error("request timed out"); } }
        }),
        (error) => typeof error === "string" && error.includes("OCR 请求超时")
    );

    assert.match(
        plugin.formatHttpError("https://example.com/v1/chat/completions", 408, { error: { message: "timeout" } }),
        /OCR 请求超时/
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
