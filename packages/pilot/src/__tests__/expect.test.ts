import { describe, it, expect as vitestExpect, vi } from "vitest";
import { expect as pilotExpect } from "../expect.js";
import { ElementHandle } from "../element-handle.js";
import { text } from "../selectors.js";
import type {
  PilotGrpcClient,
  FindElementResponse,
  FindElementsResponse,
  ElementInfo,
} from "../grpc-client.js";

// ─── Mock helpers ───

function makeElementInfo(overrides: Partial<ElementInfo> = {}): ElementInfo {
  return {
    elementId: "el-1",
    className: "android.widget.TextView",
    text: "",
    contentDescription: "",
    resourceId: "",
    enabled: true,
    visible: true,
    clickable: false,
    focusable: false,
    scrollable: false,
    hint: "",
    checked: false,
    selected: false,
    focused: false,
    role: "",
    viewportRatio: 1.0,
    ...overrides,
  };
}

function makeMockClient(
  findElementImpl: () => Promise<FindElementResponse>,
  findElementsImpl?: () => Promise<FindElementsResponse>,
): PilotGrpcClient {
  return {
    findElement: vi.fn(findElementImpl),
    findElements: vi.fn(
      findElementsImpl ??
        (async () => ({
          requestId: "1",
          elements: [],
          errorMessage: "",
        })),
    ),
  } as unknown as PilotGrpcClient;
}

function makeHandle(
  client: PilotGrpcClient,
  selector = text("Hello"),
  timeoutMs = 100,
): ElementHandle {
  return new ElementHandle(client, selector, timeoutMs);
}

// ─── toBeVisible() ───

describe("toBeVisible()", () => {
  it("passes when element is visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeVisible({ timeout: 50 });
  });

  it("fails when element is not visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeVisible({ timeout: 50 }),
    ).rejects.toThrow("to be visible");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeVisible({ timeout: 50 }),
    ).rejects.toThrow("to be visible");
  });

  it("not.toBeVisible() passes when element is not visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toBeVisible({ timeout: 50 });
  });

  it("not.toBeVisible() fails when element is visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toBeVisible({ timeout: 50 }),
    ).rejects.toThrow("NOT to be visible");
  });
});

// ─── toBeEnabled() ───

describe("toBeEnabled()", () => {
  it("passes when element is enabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeEnabled({ timeout: 50 });
  });

  it("fails when element is disabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeEnabled({ timeout: 50 }),
    ).rejects.toThrow("to be enabled");
  });

  it("not.toBeEnabled() passes when element is disabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toBeEnabled({ timeout: 50 });
  });

  it("not.toBeEnabled() fails when element is enabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toBeEnabled({ timeout: 50 }),
    ).rejects.toThrow("NOT to be enabled");
  });
});

// ─── toHaveText() ───

describe("toHaveText()", () => {
  it("passes when text matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "Hello World" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toHaveText("Hello World", { timeout: 50 });
  });

  it("fails when text does not match", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "Wrong text" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveText("Expected text", { timeout: 50 }),
    ).rejects.toThrow('to have text "Expected text"');
  });

  it("includes actual text in error message", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "actual" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveText("expected", { timeout: 50 }),
    ).rejects.toThrow('got "actual"');
  });

  it("not.toHaveText() passes when text differs", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "different" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toHaveText("expected", { timeout: 50 });
  });

  it("not.toHaveText() fails when text matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "same" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toHaveText("same", { timeout: 50 }),
    ).rejects.toThrow("NOT to have text");
  });
});

// ─── toExist() ───

describe("toExist()", () => {
  it("passes when element exists", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo(),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toExist({ timeout: 50 });
  });

  it("fails when element does not exist", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toExist({ timeout: 50 }),
    ).rejects.toThrow("to exist");
  });

  it("not.toExist() passes when element is absent", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toExist({ timeout: 50 });
  });

  it("not.toExist() fails when element exists", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo(),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toExist({ timeout: 50 }),
    ).rejects.toThrow("NOT to exist");
  });
});

// ─── toBeChecked() (PILOT-29) ───

describe("toBeChecked()", () => {
  it("passes when element is checked", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ checked: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeChecked({ timeout: 50 });
  });

  it("fails when element is not checked", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ checked: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeChecked({ timeout: 50 }),
    ).rejects.toThrow("to be checked");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeChecked({ timeout: 50 }),
    ).rejects.toThrow("to be checked");
  });

  it("not.toBeChecked() passes when element is unchecked", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ checked: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toBeChecked({ timeout: 50 });
  });

  it("not.toBeChecked() fails when element is checked", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ checked: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toBeChecked({ timeout: 50 }),
    ).rejects.toThrow("NOT to be checked");
  });
});

// ─── toBeDisabled() (PILOT-30) ───

describe("toBeDisabled()", () => {
  it("passes when element is disabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeDisabled({ timeout: 50 });
  });

  it("fails when element is enabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeDisabled({ timeout: 50 }),
    ).rejects.toThrow("to be disabled");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeDisabled({ timeout: 50 }),
    ).rejects.toThrow("to be disabled");
  });

  it("not.toBeDisabled() passes when element is enabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toBeDisabled({ timeout: 50 });
  });

  it("not.toBeDisabled() fails when element is disabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ enabled: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toBeDisabled({ timeout: 50 }),
    ).rejects.toThrow("NOT to be disabled");
  });
});

// ─── toBeHidden() (PILOT-31) ───

describe("toBeHidden()", () => {
  it("passes when element is not visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeHidden({ timeout: 50 });
  });

  it("passes when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeHidden({ timeout: 50 });
  });

  it("fails when element is visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeHidden({ timeout: 50 }),
    ).rejects.toThrow("to be hidden");
  });

  it("not.toBeHidden() passes when element is visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toBeHidden({ timeout: 50 });
  });

  it("not.toBeHidden() fails when element is not visible", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toBeHidden({ timeout: 50 }),
    ).rejects.toThrow("NOT to be hidden");
  });

  it("passes when client throws (element gone)", async () => {
    const client = makeMockClient(async () => {
      throw new Error("connection lost");
    });
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeHidden({ timeout: 50 });
  });
});

// ─── toBeEmpty() (PILOT-32) ───

describe("toBeEmpty()", () => {
  it("passes when element has empty text", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeEmpty({ timeout: 50 });
  });

  it("fails when element has text", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "some text" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeEmpty({ timeout: 50 }),
    ).rejects.toThrow("to be empty");
  });

  it("includes actual text in error message", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "content" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeEmpty({ timeout: 50 }),
    ).rejects.toThrow('had text "content"');
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeEmpty({ timeout: 50 }),
    ).rejects.toThrow("to be empty");
  });

  it("not.toBeEmpty() passes when element has text", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "some content" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toBeEmpty({ timeout: 50 });
  });

  it("not.toBeEmpty() fails when element is empty", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toBeEmpty({ timeout: 50 }),
    ).rejects.toThrow("NOT to be empty");
  });
});

// ─── toBeFocused() (PILOT-33) ───

describe("toBeFocused()", () => {
  it("passes when element is focused", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ focused: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeFocused({ timeout: 50 });
  });

  it("fails when element is not focused", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ focused: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeFocused({ timeout: 50 }),
    ).rejects.toThrow("to be focused");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeFocused({ timeout: 50 }),
    ).rejects.toThrow("to be focused");
  });

  it("not.toBeFocused() passes when element is not focused", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ focused: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toBeFocused({ timeout: 50 });
  });

  it("not.toBeFocused() fails when element is focused", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ focused: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toBeFocused({ timeout: 50 }),
    ).rejects.toThrow("NOT to be focused");
  });
});

// ─── toContainText() (PILOT-34) ───

describe("toContainText()", () => {
  it("passes when text contains substring", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "Hello World" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toContainText("World", { timeout: 50 });
  });

  it("passes when text matches regex", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "42 items found" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toContainText(/\d+ items/, { timeout: 50 });
  });

  it("fails when text does not contain substring", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "Hello World" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toContainText("Missing", { timeout: 50 }),
    ).rejects.toThrow("to contain text");
  });

  it("fails when text does not match regex", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "no numbers here" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toContainText(/\d+ items/, { timeout: 50 }),
    ).rejects.toThrow("to contain text");
  });

  it("includes actual text in error message", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "actual text" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toContainText("missing", { timeout: 50 }),
    ).rejects.toThrow('got "actual text"');
  });

  it("not.toContainText() passes when text does not contain", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "Hello World" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toContainText("Missing", { timeout: 50 });
  });

  it("not.toContainText() fails when text contains", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "Hello World" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toContainText("World", { timeout: 50 }),
    ).rejects.toThrow("NOT to contain text");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toContainText("anything", { timeout: 50 }),
    ).rejects.toThrow("to contain text");
  });
});

// ─── toHaveCount() (PILOT-35) ───

describe("toHaveCount()", () => {
  it("passes when count matches", async () => {
    const client = makeMockClient(
      async () => ({
        requestId: "1",
        found: true,
        element: makeElementInfo(),
        errorMessage: "",
      }),
      async () => ({
        requestId: "1",
        elements: [makeElementInfo(), makeElementInfo(), makeElementInfo()],
        errorMessage: "",
      }),
    );
    const handle = makeHandle(client);
    await pilotExpect(handle).toHaveCount(3, { timeout: 50 });
  });

  it("passes with count 0 when no elements found", async () => {
    const client = makeMockClient(
      async () => ({
        requestId: "1",
        found: false,
        errorMessage: "",
      }),
      async () => ({
        requestId: "1",
        elements: [],
        errorMessage: "",
      }),
    );
    const handle = makeHandle(client);
    await pilotExpect(handle).toHaveCount(0, { timeout: 50 });
  });

  it("fails when count does not match", async () => {
    const client = makeMockClient(
      async () => ({
        requestId: "1",
        found: true,
        element: makeElementInfo(),
        errorMessage: "",
      }),
      async () => ({
        requestId: "1",
        elements: [makeElementInfo(), makeElementInfo()],
        errorMessage: "",
      }),
    );
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveCount(5, { timeout: 50 }),
    ).rejects.toThrow("to have count 5");
  });

  it("includes actual count in error message", async () => {
    const client = makeMockClient(
      async () => ({
        requestId: "1",
        found: true,
        element: makeElementInfo(),
        errorMessage: "",
      }),
      async () => ({
        requestId: "1",
        elements: [makeElementInfo(), makeElementInfo()],
        errorMessage: "",
      }),
    );
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveCount(5, { timeout: 50 }),
    ).rejects.toThrow("found 2");
  });

  it("not.toHaveCount() passes when count differs", async () => {
    const client = makeMockClient(
      async () => ({
        requestId: "1",
        found: true,
        element: makeElementInfo(),
        errorMessage: "",
      }),
      async () => ({
        requestId: "1",
        elements: [makeElementInfo(), makeElementInfo()],
        errorMessage: "",
      }),
    );
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toHaveCount(5, { timeout: 50 });
  });

  it("not.toHaveCount() fails when count matches", async () => {
    const client = makeMockClient(
      async () => ({
        requestId: "1",
        found: true,
        element: makeElementInfo(),
        errorMessage: "",
      }),
      async () => ({
        requestId: "1",
        elements: [makeElementInfo(), makeElementInfo()],
        errorMessage: "",
      }),
    );
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toHaveCount(2, { timeout: 50 }),
    ).rejects.toThrow("NOT to have count");
  });
});

// ─── toHaveAttribute() (PILOT-36) ───

describe("toHaveAttribute()", () => {
  it("passes when attribute matches boolean", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ selected: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toHaveAttribute("selected", true, {
      timeout: 50,
    });
  });

  it("passes when attribute matches string", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ className: "android.widget.Button" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toHaveAttribute(
      "className",
      "android.widget.Button",
      { timeout: 50 },
    );
  });

  it("fails when attribute value does not match", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ selected: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveAttribute("selected", true, { timeout: 50 }),
    ).rejects.toThrow('to have attribute "selected"');
  });

  it("includes actual value in error message", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ className: "android.widget.TextView" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveAttribute(
        "className",
        "android.widget.Button",
        { timeout: 50 },
      ),
    ).rejects.toThrow('got "android.widget.TextView"');
  });

  it("not.toHaveAttribute() passes when value differs", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ selected: false }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toHaveAttribute("selected", true, {
      timeout: 50,
    });
  });

  it("not.toHaveAttribute() fails when value matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ selected: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toHaveAttribute("selected", true, {
        timeout: 50,
      }),
    ).rejects.toThrow("NOT to have attribute");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveAttribute("enabled", true, { timeout: 50 }),
    ).rejects.toThrow("to have attribute");
  });
});

// ─── toHaveAccessibleName() (PILOT-37) ───

describe("toHaveAccessibleName()", () => {
  it("passes when contentDescription matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ contentDescription: "Submit form" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toHaveAccessibleName("Submit form", {
      timeout: 50,
    });
  });

  it("falls back to text when contentDescription is empty", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "Submit", contentDescription: "" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toHaveAccessibleName("Submit", { timeout: 50 });
  });

  it("supports regex matching", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ contentDescription: "Submit form now" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toHaveAccessibleName(/Submit.*now/, {
      timeout: 50,
    });
  });

  it("fails when accessible name does not match", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ contentDescription: "Cancel", text: "" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveAccessibleName("Submit", { timeout: 50 }),
    ).rejects.toThrow("to have accessible name");
  });

  it("not.toHaveAccessibleName() passes when name differs", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ contentDescription: "Cancel" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toHaveAccessibleName("Submit", {
      timeout: 50,
    });
  });

  it("not.toHaveAccessibleName() fails when name matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ contentDescription: "Submit" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toHaveAccessibleName("Submit", { timeout: 50 }),
    ).rejects.toThrow("NOT to have accessible name");
  });
});

// ─── toHaveAccessibleDescription() (PILOT-37) ───

describe("toHaveAccessibleDescription()", () => {
  it("passes when hint matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ hint: "Enter your email" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toHaveAccessibleDescription("Enter your email", {
      timeout: 50,
    });
  });

  it("supports regex matching", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ hint: "Profile photo of user" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toHaveAccessibleDescription(/Profile photo/, {
      timeout: 50,
    });
  });

  it("fails when hint does not match", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ hint: "Enter username" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveAccessibleDescription("Enter email", {
        timeout: 50,
      }),
    ).rejects.toThrow("to have accessible description");
  });

  it("not.toHaveAccessibleDescription() passes when hint differs", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ hint: "Enter username" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toHaveAccessibleDescription("Enter email", {
      timeout: 50,
    });
  });

  it("not.toHaveAccessibleDescription() fails when hint matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ hint: "Enter email" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toHaveAccessibleDescription("Enter email", {
        timeout: 50,
      }),
    ).rejects.toThrow("NOT to have accessible description");
  });
});

// ─── toHaveRole() (PILOT-38) ───

describe("toHaveRole()", () => {
  it("passes when role matches from role field", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ role: "button" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toHaveRole("button", { timeout: 50 });
  });

  it("falls back to className-based role resolution", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "",
        className: "android.widget.Button",
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toHaveRole("button", { timeout: 50 });
  });

  it("passes with switch role", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "switch",
        className: "android.widget.Switch",
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toHaveRole("switch", { timeout: 50 });
  });

  it("fails when role does not match", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "button",
        className: "android.widget.Button",
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveRole("textfield", { timeout: 50 }),
    ).rejects.toThrow('to have role "textfield"');
  });

  it("includes actual role in error message", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ role: "button" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveRole("switch", { timeout: 50 }),
    ).rejects.toThrow('got "button"');
  });

  it("not.toHaveRole() passes when role differs", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ role: "button" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toHaveRole("textfield", { timeout: 50 });
  });

  it("not.toHaveRole() fails when role matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ role: "button" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toHaveRole("button", { timeout: 50 }),
    ).rejects.toThrow("NOT to have role");
  });
});

// ─── toHaveValue() (PILOT-39) ───

describe("toHaveValue()", () => {
  it("passes when value matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "test@example.com" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toHaveValue("test@example.com", { timeout: 50 });
  });

  it("fails when value does not match", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "wrong@example.com" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveValue("test@example.com", { timeout: 50 }),
    ).rejects.toThrow('to have value "test@example.com"');
  });

  it("includes actual value in error message", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "actual" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveValue("expected", { timeout: 50 }),
    ).rejects.toThrow('got "actual"');
  });

  it("not.toHaveValue() passes when value differs", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "different" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toHaveValue("expected", { timeout: 50 });
  });

  it("not.toHaveValue() fails when value matches", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ text: "same" }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toHaveValue("same", { timeout: 50 }),
    ).rejects.toThrow("NOT to have value");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveValue("any", { timeout: 50 }),
    ).rejects.toThrow("to have value");
  });
});

// ─── toBeEditable() (PILOT-40) ───

describe("toBeEditable()", () => {
  it("passes when element is an enabled textfield by role", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "textfield",
        className: "android.widget.EditText",
        enabled: true,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeEditable({ timeout: 50 });
  });

  it("passes when element is an enabled EditText by className", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "",
        className: "android.widget.EditText",
        enabled: true,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeEditable({ timeout: 50 });
  });

  it("passes with Material TextInputEditText", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "textfield",
        className: "com.google.android.material.textfield.TextInputEditText",
        enabled: true,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeEditable({ timeout: 50 });
  });

  it("fails when element is not a textfield", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "button",
        className: "android.widget.Button",
        enabled: true,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeEditable({ timeout: 50 }),
    ).rejects.toThrow("to be editable");
  });

  it("fails when textfield is disabled", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "textfield",
        className: "android.widget.EditText",
        enabled: false,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeEditable({ timeout: 50 }),
    ).rejects.toThrow("to be editable");
  });

  it("not.toBeEditable() passes when element is not editable", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "button",
        className: "android.widget.Button",
        enabled: true,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toBeEditable({ timeout: 50 });
  });

  it("not.toBeEditable() passes when textfield is disabled (read-only)", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "textfield",
        className: "android.widget.EditText",
        enabled: false,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toBeEditable({ timeout: 50 });
  });

  it("not.toBeEditable() fails when element is editable", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({
        role: "textfield",
        className: "android.widget.EditText",
        enabled: true,
      }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toBeEditable({ timeout: 50 }),
    ).rejects.toThrow("NOT to be editable");
  });
});

// ─── toBeInViewport() (PILOT-41) ───

describe("toBeInViewport()", () => {
  it("passes when element is in viewport", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 1.0 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeInViewport({ timeout: 50 });
  });

  it("passes when element is partially in viewport", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 0.3 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeInViewport({ timeout: 50 });
  });

  it("passes with ratio option when ratio is sufficient", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 0.75 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeInViewport({ timeout: 50, ratio: 0.5 });
  });

  it("fails when element is not in viewport", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 0.0 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeInViewport({ timeout: 50 }),
    ).rejects.toThrow("to be in viewport");
  });

  it("fails when ratio is below required threshold", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 0.3 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeInViewport({ timeout: 50, ratio: 0.5 }),
    ).rejects.toThrow("to be in viewport");
  });

  it("includes ratio info in error message when ratio specified", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 0.2 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeInViewport({ timeout: 50, ratio: 0.5 }),
    ).rejects.toThrow("ratio >= 0.5");
  });

  it("not.toBeInViewport() passes when element is off-screen", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 0.0 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toBeInViewport({ timeout: 50 });
  });

  it("not.toBeInViewport() fails when element is on-screen", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ viewportRatio: 1.0 }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toBeInViewport({ timeout: 50 }),
    ).rejects.toThrow("NOT to be in viewport");
  });

  it("fails when element is not found", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: false,
      errorMessage: "not found",
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeInViewport({ timeout: 50 }),
    ).rejects.toThrow("to be in viewport");
  });
});

// ─── Timeout and polling ───

describe("polling behavior", () => {
  it("retries until element becomes visible within timeout", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      return {
        requestId: "1",
        found: true,
        element: makeElementInfo({ visible: callCount >= 3 }),
        errorMessage: "",
      };
    });
    const handle = makeHandle(client, text("delayed"), 2000);
    await pilotExpect(handle).toBeVisible({ timeout: 2000 });
    vitestExpect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("handles client errors gracefully during polling", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount < 3) throw new Error("connection error");
      return {
        requestId: "1",
        found: true,
        element: makeElementInfo({ visible: true }),
        errorMessage: "",
      };
    });
    const handle = makeHandle(client, text("retry"), 2000);
    await pilotExpect(handle).toBeVisible({ timeout: 2000 });
    vitestExpect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("uses handle timeout when no explicit timeout given", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client, text("test"), 500);
    // Should not throw - uses the 500ms handle timeout
    await pilotExpect(handle).toBeVisible();
  });

  it("retries toBeChecked until condition is met", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      return {
        requestId: "1",
        found: true,
        element: makeElementInfo({ checked: callCount >= 3 }),
        errorMessage: "",
      };
    });
    const handle = makeHandle(client, text("toggle"), 2000);
    await pilotExpect(handle).toBeChecked({ timeout: 2000 });
    vitestExpect(callCount).toBeGreaterThanOrEqual(3);
  });
});

// ─── Negated polling (fast-path) ───

describe("negated assertion polling", () => {
  it("not.toBeVisible() returns immediately when element is not visible", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      return {
        requestId: "1",
        found: true,
        element: makeElementInfo({ visible: false }),
        errorMessage: "",
      };
    });
    const handle = makeHandle(client, text("hidden"), 5000);
    const start = Date.now();
    await pilotExpect(handle).not.toBeVisible({ timeout: 5000 });
    const elapsed = Date.now() - start;
    // Should return almost immediately, well under the 5s timeout
    vitestExpect(elapsed).toBeLessThan(2000);
    vitestExpect(callCount).toBeLessThanOrEqual(3);
  });

  it("not.toBeVisible() polls until element disappears", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      // Visible for first 2 calls, then hidden
      return {
        requestId: "1",
        found: true,
        element: makeElementInfo({ visible: callCount < 3 }),
        errorMessage: "",
      };
    });
    const handle = makeHandle(client, text("disappearing"), 2000);
    await pilotExpect(handle).not.toBeVisible({ timeout: 2000 });
    vitestExpect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("not.toBeVisible() fails if element stays visible past timeout", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client, text("sticky"), 300);
    await vitestExpect(
      pilotExpect(handle).not.toBeVisible({ timeout: 300 }),
    ).rejects.toThrow("NOT to be visible");
  });

  it("not.toBeChecked() returns immediately when unchecked", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      return {
        requestId: "1",
        found: true,
        element: makeElementInfo({ checked: false }),
        errorMessage: "",
      };
    });
    const handle = makeHandle(client, text("switch"), 5000);
    const start = Date.now();
    await pilotExpect(handle).not.toBeChecked({ timeout: 5000 });
    const elapsed = Date.now() - start;
    vitestExpect(elapsed).toBeLessThan(2000);
    vitestExpect(callCount).toBeLessThanOrEqual(3);
  });

  it("not.toExist() returns immediately when element does not exist", async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      return {
        requestId: "1",
        found: false,
        element: undefined as unknown as ElementInfo,
        errorMessage: "",
      };
    });
    const handle = makeHandle(client, text("gone"), 5000);
    const start = Date.now();
    await pilotExpect(handle).not.toExist({ timeout: 5000 });
    const elapsed = Date.now() - start;
    vitestExpect(elapsed).toBeLessThan(2000);
    vitestExpect(callCount).toBeLessThanOrEqual(3);
  });
});

// ─── Double negation ───

describe("double negation", () => {
  it("not.not behaves like positive assertion", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.not.toBeVisible({ timeout: 50 });
  });

  it("not.not works for new assertions too", async () => {
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ checked: true }),
      errorMessage: "",
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.not.toBeChecked({ timeout: 50 });
  });
});

// ─── wrapAssertionWithTrace ───

describe("wrapAssertionWithTrace", () => {
  function makeTracedHandle(
    client: PilotGrpcClient,
    collector: {
      captureBeforeAction: ReturnType<typeof vi.fn>;
      captureAfterAction: ReturnType<typeof vi.fn>;
      addAssertionEvent: ReturnType<typeof vi.fn>;
    },
  ): ElementHandle {
    const traceCapture = {
      collector,
      takeScreenshot: async () => undefined,
      captureHierarchy: async () => undefined,
    };
    return new ElementHandle(client, text("Traced"), 100, {
      traceCapture: traceCapture as unknown as import("../trace/trace-collector.js").TraceCapture,
    });
  }

  function makeMockCollector() {
    return {
      captureBeforeAction: vi.fn(async () => ({
        actionIndex: 0,
        captures: {},
      })),
      captureAfterAction: vi.fn(async () => ({})),
      addAssertionEvent: vi.fn(),
      setPendingOperation: vi.fn(),
      clearPendingOperation: vi.fn(),
      trackPendingCapture: vi.fn(),
    };
  }

  it("emits a passing assertion event when tracing is active", async () => {
    const collector = makeMockCollector();
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeTracedHandle(client, collector);

    await pilotExpect(handle).toBeVisible({ timeout: 50 });

    vitestExpect(collector.addAssertionEvent).toHaveBeenCalledTimes(1);
    const event = collector.addAssertionEvent.mock.calls[0][0];
    vitestExpect(event.assertion).toBe("toBeVisible");
    vitestExpect(event.passed).toBe(true);
    vitestExpect(event.negated).toBe(false);
    vitestExpect(event.soft).toBe(false);
  });

  it("emits a failing assertion event when tracing is active", async () => {
    const collector = makeMockCollector();
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: false }),
      errorMessage: "",
    }));
    const handle = makeTracedHandle(client, collector);

    await vitestExpect(
      pilotExpect(handle).toBeVisible({ timeout: 50 }),
    ).rejects.toThrow("to be visible");

    vitestExpect(collector.addAssertionEvent).toHaveBeenCalledTimes(1);
    const event = collector.addAssertionEvent.mock.calls[0][0];
    vitestExpect(event.assertion).toBe("toBeVisible");
    vitestExpect(event.passed).toBe(false);
    vitestExpect(event.error).toBeDefined();
  });

  it("emits negated assertion event for not.toBeVisible()", async () => {
    const collector = makeMockCollector();
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: false }),
      errorMessage: "",
    }));
    const handle = makeTracedHandle(client, collector);

    await pilotExpect(handle).not.toBeVisible({ timeout: 50 });

    vitestExpect(collector.addAssertionEvent).toHaveBeenCalledTimes(1);
    const event = collector.addAssertionEvent.mock.calls[0][0];
    vitestExpect(event.assertion).toBe("not.toBeVisible");
    vitestExpect(event.negated).toBe(true);
    vitestExpect(event.passed).toBe(true);
  });

  it("captures before and after screenshots", async () => {
    const collector = makeMockCollector();
    const client = makeMockClient(async () => ({
      requestId: "1",
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: "",
    }));
    const handle = makeTracedHandle(client, collector);

    await pilotExpect(handle).toBeVisible({ timeout: 50 });

    vitestExpect(collector.captureBeforeAction).toHaveBeenCalledTimes(1);
    vitestExpect(collector.captureAfterAction).toHaveBeenCalledTimes(1);
  });
});
