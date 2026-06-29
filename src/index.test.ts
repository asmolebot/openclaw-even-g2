import { describe, expect, it } from "vitest";
import entry, { normalizeGlassesText, promptFromMessages, textFromAgentJson } from "./index.js";

describe("even-g2", () => {
  it("declares plugin identity", () => {
    expect(entry.id).toBe("even-g2");
    expect(entry.name).toBe("Even G2");
  });

  it("renders OpenAI-style text messages into one prompt", () => {
    expect(
      promptFromMessages([
        { role: "system", content: "Be brief." },
        { role: "user", content: "What is on my calendar?" },
      ]),
    ).toBe("system: Be brief.\n\nuser: What is on my calendar?");
  });

  it("renders multimodal-style text parts and ignores non-text parts", () => {
    expect(
      promptFromMessages([
        {
          role: "user",
          content: [
            { type: "text", text: "First" },
            { type: "image_url", image_url: { url: "https://example.test/image.png" } },
            { text: "Second" },
          ],
        },
      ]),
    ).toBe("user: First\nSecond");
  });

  it("extracts text from OpenClaw agent JSON payloads", () => {
    expect(
      textFromAgentJson({
        result: {
          payloads: [{ text: "even g2 ready" }],
        },
      }),
    ).toBe("even g2 ready");
  });

  it("normalizes markdown-heavy text for glasses display", () => {
    expect(normalizeGlassesText("**Done**: [details](https://example.test)\n\n\n`ok`")).toBe("Done: details\n\nok");
  });
});
