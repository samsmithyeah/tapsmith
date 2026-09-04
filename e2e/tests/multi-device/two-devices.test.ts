import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, test } from "../../fixtures.js"
import { ChatScreen } from "../../screens/chat.screen.js"
import { HomeScreen } from "../../screens/home.screen.js"
import { LoginScreen } from "../../screens/login.screen.js"

// Two devices driven by one test (PILOT-310). Runs only under the
// `*-multi` configs, whose project declares `use.devices`; every other config
// ignores this folder.

describe("Two devices in one test", () => {
  test("receives both devices, with `device` as the primary", async ({ device, devices }) => {
    expect(devices.length).toBe(2)
    expect(devices[0]).toBe(device)
    expect(devices[1]).not.toBe(device)
  })

  test("drives both apps independently", async ({ devices: [alice, bob] }) => {
    const aliceHome = new HomeScreen(alice)
    const bobHome = new HomeScreen(bob)
    await expect(aliceHome.header).toBeVisible()
    await expect(bobHome.header).toBeVisible()

    // Alice navigates; Bob stays on the home screen.
    await aliceHome.loginCard.tap()
    await expect(new LoginScreen(alice).heading).toBeVisible()
    await expect(bobHome.header).toBeVisible()
    await expect(new LoginScreen(bob).heading).not.toBeVisible()
  })

  test("actions on both devices can run concurrently", async ({ devices: [alice, bob] }) => {
    const aliceHome = new HomeScreen(alice)
    const bobHome = new HomeScreen(bob)
    await Promise.all([aliceHome.loginCard.tap(), bobHome.listCard.tap()])
    await expect(new LoginScreen(alice).heading).toBeVisible()
    await expect(bob.getByText("List", { exact: true })).toBeVisible()
  })
})

// A real conversation: the app's Chat screen shares messages through an HTTP
// server this test hosts, so what alice sends, bob's device has to fetch and
// render — the mobile analogue of Playwright's two-context chat example.
describe("Two users chatting", () => {
  // Two real devices each polling a host server: give the auto-wait room.
  test.use({ timeout: 20_000 })

  interface Message { id: number; name: string; text: string }
  let server: Server | undefined
  let port = 0

  test.beforeAll(async () => {
    const messages: Message[] = []
    server = createServer((req, res) => {
      if (req.url !== "/messages") {
        res.writeHead(404, { "content-type": "text/plain" })
        res.end("not found")
        return
      }
      if (req.method === "POST") {
        let body = ""
        req.on("data", (chunk) => { body += chunk })
        req.on("end", () => {
          try {
            const { name, text } = JSON.parse(body) as { name: string; text: string }
            messages.push({ id: messages.length + 1, name, text })
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify(messages))
          } catch {
            res.writeHead(400, { "content-type": "text/plain" })
            res.end("bad request")
          }
        })
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(messages))
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      server!.once("error", onError)
      // Every interface: the emulator reaches the host as 10.0.2.2, which a
      // loopback-only listener would refuse.
      server!.listen(0, "0.0.0.0", () => {
        server!.off("error", onError)
        port = (server!.address() as AddressInfo).port
        resolve()
      })
    })
  })

  test.afterAll(async () => {
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()))
    })
  })

  test("alice messages bob, bob replies", async ({ devices: [alice, bob], platform }) => {
    // How an emulator / simulator addresses the machine running this test.
    const host = platform === "android" ? "10.0.2.2" : "localhost"
    const serverUrl = `http://${host}:${port}`
    const link = `tapsmithtest:///chat?server=${encodeURIComponent(serverUrl)}`

    const aliceChat = new ChatScreen(alice)
    const bobChat = new ChatScreen(bob)
    await Promise.all([alice.openDeepLink(link), bob.openDeepLink(link)])
    await expect(aliceChat.heading).toBeVisible()
    await expect(bobChat.heading).toBeVisible()

    await Promise.all([aliceChat.join("alice"), bobChat.join("bob")])

    await aliceChat.send("Hi Bob")
    await expect(bobChat.message("alice", "Hi Bob")).toBeVisible()
    await expect(aliceChat.message("alice", "Hi Bob")).toBeVisible()

    await bobChat.send("Hi Alice")
    await expect(aliceChat.message("bob", "Hi Alice")).toBeVisible()
    await expect(bobChat.message("bob", "Hi Alice")).toBeVisible()
    await expect(aliceChat.error).not.toBeVisible()
    await expect(bobChat.error).not.toBeVisible()
  })
})
