import { describe, expect, it } from "vitest";
import { isSilentAssistantTranscriptMessage } from "../../shared/chat-message-content.js";
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";

const part = (text: string, phase: string, id?: string) => ({
  type: "text",
  text,
  textSignature: JSON.stringify({ v: 1, ...(id ? { id } : {}), phase }),
});
function expectIdempotent(message: Parameters<typeof applyAssistantDeliveryDirectives>[0]) {
  const snapshot = structuredClone(message);
  applyAssistantDeliveryDirectives(message);
  expect(message).toEqual(snapshot);
}

describe("assistant delivery normalization across native parts", () => {
  it.each([
    {
      name: "reply IDs containing code bytes",
      parts: ["Prefix.", "[[reply_to:`quoted`]]Reply."],
      expected: ["Prefix.", "Reply."],
      facts: { replyToId: "`quoted`" },
    },
    {
      name: "speech text containing code and placeholder-like bytes",
      parts: ["Prefix.", "Shown. [[tts:text]]Speak `code` \uE0000\uE000.[[/tts:text]]"],
      expected: ["Prefix.", "Shown."],
      facts: { tts: { tagged: true, text: "Speak `code` \uE0000\uE000." } },
    },
    {
      name: "speech directive values containing code bytes",
      parts: ["Prefix.", "[[tts:provider=openai voice=`quoted`]]Shown."],
      expected: ["Prefix.", "Shown."],
      facts: {
        tts: { tagged: true, directives: [{ provider: "openai", values: { voice: "`quoted`" } }] },
      },
    },
    {
      name: "code whitespace around a genuine voice directive",
      parts: ["Use `", "  [[reply_to:literal]]  `\n[[audio_as_voice]]Done."],
      expected: ["Use `", "  [[reply_to:literal]]  `\nDone."],
      facts: { audioAsVoice: true },
    },
    {
      name: "literal silence text after speech extraction",
      parts: ["[[tts:text]]Spoken only.[[/tts:text]]NO_REPLY"],
      expected: ["NO_REPLY"],
      facts: { tts: { tagged: true, text: "Spoken only." } },
    },
  ])("preserves $name and remains idempotent", ({ parts, expected, facts }) => {
    const content = parts.map((text, index) => ({
      type: "text",
      text,
      textSignature: `native-${index}`,
    }));
    const identities = [...content];
    const message = { role: "assistant", content, openclawDelivery: { mediaUrls: ["./kept.png"] } };
    applyAssistantDeliveryDirectives(message);
    expect(message.content).toBe(content);
    expect(message.content.map((block) => block.text)).toEqual(expected);
    expect(message.openclawDelivery).toEqual({ mediaUrls: ["./kept.png"], ...facts });
    for (const [index, block] of message.content.entries()) {
      expect(block).toBe(identities[index]);
      expect(block.textSignature).toBe(`native-${index}`);
    }
    expectIdempotent(message);
  });

  it.each([
    { parts: ["[[audio_as_voice]]", "NO_REPLY"], display: true, hidden: false },
    { parts: ["NO_", "REPLY\n[[audio_as_voice]]NO_REPLY"], display: undefined, hidden: false },
    { parts: ["NO_REPLY"], display: undefined, hidden: true },
    { parts: ["no_", "reply\n[[audio_as_voice]]No_Reply"], display: undefined, hidden: false },
    { parts: ["No_Reply"], display: undefined, hidden: true },
  ])(
    "records visibility without reclassifying the prepared suffix: $parts",
    ({ parts, display, hidden }) => {
      const message = {
        role: "assistant",
        content: parts.map((text) => part(text, "final_answer")),
      };
      const prepared = applyAssistantDeliveryDirectives(message);
      expect("display" in prepared ? prepared.display : undefined).toBe(display);
      expect(isSilentAssistantTranscriptMessage(prepared)).toBe(hidden);
      expectIdempotent(prepared);
    },
  );

  it("preserves explicit hidden display ownership while extracting directives", () => {
    const message = {
      role: "assistant",
      display: false,
      content: [{ type: "text", text: "[[audio_as_voice]]NO_REPLY" }],
    };
    applyAssistantDeliveryDirectives(message);
    expect(message.display).toBe(false);
    expect(isSilentAssistantTranscriptMessage(message)).toBe(true);
  });

  it("keeps commentary code context separate from final intent", () => {
    const message = {
      role: "assistant",
      content: [
        part("```text\n[[reply_to:commentary]]", "commentary", "progress"),
        part("[[reply_to_current]]Final reply.", "final_answer", "answer"),
      ],
    };
    applyAssistantDeliveryDirectives(message);
    expect(message).toMatchObject({
      display: true,
      content: [{ text: "```text\n[[reply_to:commentary]]" }, { text: "Final reply." }],
      openclawDelivery: { replyToCurrent: true },
    });
  });
});
