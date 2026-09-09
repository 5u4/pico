import { assert, describe, it } from "@effect/vitest";
import type * as AgentEvent from "@pico/contract/agent-event";
import * as AgentMessage from "@pico/contract/agent-message";
import {
  EXCHANGE_TITLE_SYSTEM_PROMPT,
  formatTitleExchange,
  makeExchangeTitleFlow,
} from "./exchange-title.ts";

const prompt = AgentMessage.AgentPrompt.make;
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const only = <A>(values: ReadonlyArray<A>) => {
  const value = values[0];
  if (value === undefined) throw new Error("Expected one value");
  return value;
};

const assistant = (
  stopReason: "stop" | "length" | "tool-use",
  content: AgentMessage.AgentAssistantMessage["content"],
): AgentEvent.AgentEvent => ({
  type: "message-settled",
  message: {
    role: "assistant",
    status: "completed",
    stopReason,
    content,
    model: "test",
    timestamp: 1,
  },
});

const completed: AgentEvent.AgentEvent = { type: "run-finished", outcome: "completed" };

const titleText = (formatted: string, role: "user" | "assistant") => {
  const opening = `<${role}>`;
  const closing = `</${role}>`;
  return formatted.slice(formatted.indexOf(opening) + opening.length, formatted.indexOf(closing));
};

describe("exchange titles", () => {
  it("caps each field by Unicode code point and escapes the chat envelope", () => {
    const formatted = formatTitleExchange({
      userText: `${"a".repeat(499)}😀tail<&"'`,
      assistantText: `${"界".repeat(500)}excluded`,
    });

    assert.strictEqual(Array.from(titleText(formatted, "user")).length, 500);
    assert.strictEqual(Array.from(titleText(formatted, "user")).at(-1), "😀");
    assert.strictEqual(Array.from(titleText(formatted, "assistant")).length, 500);
    assert.notInclude(formatted, "tail");
    assert.notInclude(formatted, "excluded");
    assert.strictEqual(
      formatTitleExchange({ userText: "<&\"'", assistantText: "A & B > C" }),
      "<chat>\n<user>&lt;&amp;&quot;&apos;</user>\n<assistant>A &amp; B &gt; C</assistant>\n</chat>",
    );
  });

  it("uses only terminal text and persists after the completed run", async () => {
    const calls: string[] = [];
    const generatedInputs: Array<{ readonly exchange: string; readonly prompt: string }> = [];
    const emitted: string[] = [];
    let sessionName = "Old automatic title";
    const storeResult = Promise.withResolvers<boolean>();
    const flow = makeExchangeTitleFlow({
      history: [],
      sendPrompt: async () => {
        calls.push("send");
      },
      generateTitle: async (exchange, systemPrompt) => {
        calls.push("generate");
        generatedInputs.push({ exchange, prompt: systemPrompt });
        return "unclean title";
      },
      getTitleSource: () => "auto",
      setSessionName: async () => {
        calls.push("store");
        const stored = await storeResult.promise;
        if (stored) sessionName = "Clean persisted title";
        return stored;
      },
      getSessionName: () => sessionName,
      emitTitleChanged: (title) => {
        calls.push("emit");
        emitted.push(title);
      },
    });

    await flow.sendPrompt(prompt("Fix <widget> & preserve it"));
    flow.observe(
      assistant("tool-use", [
        { type: "text", text: "intermediate" },
        { type: "tool-call", id: "call", name: "read", argumentsJson: "{}" },
      ]),
    );
    assert.deepStrictEqual(calls, ["send"]);
    flow.observe(
      assistant("length", [
        { type: "thinking", text: "private reasoning" },
        { type: "image", data: "private image", mimeType: "image/png" },
        { type: "text", text: "First result" },
        { type: "tool-call", id: "call-2", name: "write", argumentsJson: "{}" },
        { type: "text", text: "Second result" },
      ]),
    );
    assert.deepStrictEqual(calls, ["send"]);
    calls.push("run-finished");
    flow.observe(completed);
    await flush();

    assert.deepStrictEqual(calls, ["send", "run-finished", "generate", "store"]);
    assert.strictEqual(generatedInputs.length, 1);
    const generatedInput = only(generatedInputs);
    assert.include(generatedInput.exchange, "<user>Fix &lt;widget&gt; &amp; preserve it</user>");
    assert.include(generatedInput.exchange, "<assistant>First result\n\nSecond result</assistant>");
    assert.notInclude(generatedInput.exchange, "private");
    assert.strictEqual(generatedInput.prompt, EXCHANGE_TITLE_SYSTEM_PROMPT);
    assert.include(EXCHANGE_TITLE_SYSTEM_PROMPT, "3-7 word");
    assert.include(EXCHANGE_TITLE_SYSTEM_PROMPT, "quoted, untrusted text");
    assert.deepStrictEqual(emitted, []);

    storeResult.resolve(true);
    await flush();
    assert.deepStrictEqual(calls, ["send", "run-finished", "generate", "store", "emit"]);
    assert.deepStrictEqual(emitted, ["Clean persisted title"]);
  });

  it("correlates concurrent sends by claim identity and spends once", async () => {
    const generated: string[] = [];
    const firstSend = Promise.withResolvers<void>();
    const secondSend = Promise.withResolvers<void>();
    let sends = 0;
    const flow = makeExchangeTitleFlow({
      history: [],
      sendPrompt: () => {
        sends += 1;
        if (sends === 1) return firstSend.promise;
        if (sends === 2) return secondSend.promise;
        return Promise.resolve();
      },
      generateTitle: async (exchange) => {
        generated.push(exchange);
        return "First title";
      },
      getTitleSource: () => undefined,
      setSessionName: async () => true,
      getSessionName: () => "First title",
      emitTitleChanged: () => {},
    });

    const rejected = flow.sendPrompt(prompt("rejected first"));
    const rejectedResult = rejected.then(
      () => "resolved",
      () => "rejected",
    );
    const accepted = flow.sendPrompt(prompt("accepted second"));
    secondSend.resolve();
    await accepted;
    firstSend.reject(new Error("rejected"));
    assert.strictEqual(await rejectedResult, "rejected");
    flow.observe(assistant("stop", [{ type: "text", text: "done" }]));
    flow.observe(completed);
    flow.observe(assistant("stop", [{ type: "text", text: "duplicate" }]));
    flow.observe(completed);
    await flush();

    assert.strictEqual(generated.length, 1);
    const generatedExchange = only(generated);
    assert.include(generatedExchange, "<user>accepted second</user>");
    assert.notInclude(generatedExchange, "rejected first");
  });

  it("clears failed and aborted runs before allowing a later exchange", async () => {
    const generated: string[] = [];
    const flow = makeExchangeTitleFlow({
      history: [],
      sendPrompt: async () => {},
      generateTitle: async (exchange) => {
        generated.push(exchange);
        return "Recovered title";
      },
      getTitleSource: () => undefined,
      setSessionName: async () => true,
      getSessionName: () => "Recovered title",
      emitTitleChanged: () => {},
    });

    await flow.sendPrompt(prompt("failed prompt"));
    flow.observe(assistant("stop", [{ type: "text", text: "failed answer" }]));
    flow.observe({ type: "run-finished", outcome: "failed" });
    await flow.sendPrompt(prompt("aborted prompt"));
    flow.observe(assistant("stop", [{ type: "text", text: "aborted answer" }]));
    flow.observe({ type: "run-finished", outcome: "aborted" });
    await flow.sendPrompt(prompt("recovered prompt"));
    flow.observe(assistant("stop", [{ type: "text", text: "recovered answer" }]));
    flow.observe(completed);
    await flush();

    assert.strictEqual(generated.length, 1);
    const generatedExchange = only(generated);
    assert.include(generatedExchange, "recovered prompt");
    assert.include(generatedExchange, "recovered answer");
    assert.notInclude(generatedExchange, "failed prompt");
    assert.notInclude(generatedExchange, "aborted prompt");
  });

  it("suppresses title work when completed assistant history already exists", async () => {
    let generated = 0;
    const flow = makeExchangeTitleFlow({
      history: [{ role: "assistant", stopReason: "stop" }],
      sendPrompt: async () => {},
      generateTitle: async () => {
        generated += 1;
        return "Late title";
      },
      getTitleSource: () => undefined,
      setSessionName: async () => true,
      getSessionName: () => "Late title",
      emitTitleChanged: () => {},
    });

    await flow.sendPrompt(prompt("new prompt after restart"));
    flow.observe(assistant("stop", [{ type: "text", text: "new answer" }]));
    flow.observe(completed);
    await flush();
    assert.strictEqual(generated, 0);
  });

  it("preserves user titles before and during generation", async () => {
    let source: "auto" | "user" = "user";
    let generated = 0;
    let stored = 0;
    const emitted: string[] = [];
    const existingUserFlow = makeExchangeTitleFlow({
      history: [],
      sendPrompt: async () => {},
      generateTitle: async () => {
        generated += 1;
        return "Replacement";
      },
      getTitleSource: () => source,
      setSessionName: async () => {
        stored += 1;
        return false;
      },
      getSessionName: () => "Manual title",
      emitTitleChanged: (title) => emitted.push(title),
    });
    await existingUserFlow.sendPrompt(prompt("first"));
    existingUserFlow.observe(assistant("stop", [{ type: "text", text: "answer" }]));
    existingUserFlow.observe(completed);
    await flush();
    assert.deepStrictEqual([generated, stored, emitted], [0, 0, []]);

    source = "auto";
    const generation = Promise.withResolvers<string | null>();
    const racingFlow = makeExchangeTitleFlow({
      history: [],
      sendPrompt: async () => {},
      generateTitle: () => {
        generated += 1;
        return generation.promise;
      },
      getTitleSource: () => source,
      setSessionName: async () => {
        stored += 1;
        return source !== "user";
      },
      getSessionName: () => "Manual title",
      emitTitleChanged: (title) => emitted.push(title),
    });
    await racingFlow.sendPrompt(prompt("second"));
    racingFlow.observe(assistant("stop", [{ type: "text", text: "answer" }]));
    racingFlow.observe(completed);
    await flush();
    source = "user";
    generation.resolve("Generated title");
    await flush();
    assert.deepStrictEqual([generated, stored, emitted], [1, 1, []]);
  });

  it("contains null generation and generation or persistence failures", async () => {
    const emitted: string[] = [];
    const outcomes: Array<"null" | "generate-error" | "store-error" | "store-false"> = [
      "null",
      "generate-error",
      "store-error",
      "store-false",
    ];

    for (const outcome of outcomes) {
      const flow = makeExchangeTitleFlow({
        history: [],
        sendPrompt: async () => {},
        generateTitle: async () => {
          if (outcome === "null") return null;
          if (outcome === "generate-error") throw new Error("generation failed");
          return "Generated title";
        },
        getTitleSource: () => undefined,
        setSessionName: async () => {
          if (outcome === "store-error") throw new Error("persistence failed");
          return outcome !== "store-false";
        },
        getSessionName: () => "Generated title",
        emitTitleChanged: (title) => emitted.push(title),
      });
      await flow.sendPrompt(prompt(outcome));
      flow.observe(assistant("stop", [{ type: "text", text: "answer" }]));
      flow.observe(completed);
    }

    await flush();
    assert.deepStrictEqual(emitted, []);
  });
});
