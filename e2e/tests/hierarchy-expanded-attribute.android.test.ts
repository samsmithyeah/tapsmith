import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// The Android hierarchy dump carries each element's expanded state as
// `tapsmith-expanded`, so the Locator Playground and the trace viewer can
// apply getByRole's `expanded` filter the way the device does (PILOT-655).
// The stock UIAutomator dump has no expanded state; the agent joins its own
// accessibility walk to the dump by the bounds the dump writes.
//
// Android-only: iOS dumps carry the state in the element's value already.

/** The `<node …>` opening tag whose content-desc is `desc`, from a hierarchy dump. */
function nodeTag(xml: string, desc: string): string | undefined {
  return xml.match(new RegExp(`<node\\b[^>]*content-desc="${desc}"[^>]*>`))?.[0]
}

async function dump(device: unknown): Promise<string> {
  // Internal gRPC client: the hierarchy dump itself is what is under test.
  const client = (device as { _client: { getUiHierarchy(): Promise<{ hierarchyXml: string }> } })._client
  return (await client.getUiHierarchy()).hierarchyXml
}

describe("hierarchy dump expanded state", () => {
  test("follows an expandable element as it expands", async ({ device }) => {
    await openScreen(device, "/visibility")
    await expect(device.getByRole("button", { name: "Toggle details", expanded: false })).toBeVisible()
    expect(nodeTag(await dump(device), "Toggle details")).toContain('tapsmith-expanded="false"')

    await device.getByRole("button", { name: "Toggle details" }).tap()
    await expect(device.getByRole("button", { name: "Toggle details", expanded: true })).toBeVisible()
    expect(nodeTag(await dump(device), "Toggle details")).toContain('tapsmith-expanded="true"')
  })

  test("leaves elements without an expanded state alone", async ({ device }) => {
    await openScreen(device, "/visibility")
    await expect(device.getByRole("button", { name: "Toggle details" })).toBeVisible()
    const xml = await dump(device)
    // Only the one expandable element in the app carries the attribute (the
    // dump also holds system UI windows, which are not the app's to pin).
    const appExpandable = (xml.match(/<node\b[^>]*>/g) ?? [])
      .filter((tag) => tag.includes('package="dev.tapsmith.testapp"') && tag.includes("tapsmith-expanded="))
    expect(appExpandable).toHaveLength(1)
    expect(appExpandable[0]).toContain('content-desc="Toggle details"')
  })
})
