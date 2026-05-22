/**
 * E2E test: agent Linear ticket reproduce + fix flow.
 *
 * Tests against the live EKS deployment. Requires MASTER_KEY env var.
 * BASE_URL and TEST_AGENT_ID fall back to known production values.
 *
 * Assertions:
 * 1. Session creates and becomes ready; sandbox tools are present.
 * 2. Sandbox provision route returns a ready sandbox.
 * 3. Sandbox execute route runs a shell command and returns output.
 * 4. Agent end-to-end: reads LIT-3210 via Linear MCP, reproduces the bug,
 *    applies a fix, and confirms it with "DONE:" in the reply.
 */

import { test, expect } from "@playwright/test";

const BASE_URL =
  process.env.BASE_URL ??
  "http://ae7fbba6b9bd94fb8ae7aa4640d70da1-1735666001.us-east-1.elb.amazonaws.com";

// CI must inject MASTER_KEY — no hardcoded fallback.
const MASTER_KEY = process.env.MASTER_KEY;
if (!MASTER_KEY) throw new Error("MASTER_KEY env var is required");

const AGENT_ID =
  process.env.TEST_AGENT_ID ?? "6b023d93-b570-4a60-a5bd-6a0b630e4a7b";

const PROJECT_ID = "litellm-sandbox-mpecoia5-asxmn";

const TURN_TIMEOUT_MS = 60_000;
const LONG_TURN_TIMEOUT_MS = 300_000; // 5 min for the full fix task

// ---------------------------------------------------------------------------
// Minimal API helpers (duplicated from inline-harness-tools.spec.ts because
// Playwright does not support shared helper imports across spec files).
// ---------------------------------------------------------------------------

async function apiPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}/api/v1/managed_agents/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MASTER_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function apiGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}/api/v1/managed_agents/${path}`, {
    headers: { Authorization: `Bearer ${MASTER_KEY}` },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function sendMessage(sessionId: string, text: string): Promise<string> {
  const data = await apiPost(`sessions/${sessionId}/message`, { text });
  const parts = (data as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [];
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

async function waitForReady(sessionId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await apiGet(`sessions/${sessionId}`);
    if (session.status === "ready") return;
    if (session.status === "failed") {
      throw new Error(`session failed: ${session.failure_reason}`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`session ${sessionId} never became ready within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("agent — Linear ticket reproduce + fix flow", () => {
  let sessionId: string;

  test.beforeAll(async () => {
    const session = await apiPost(`agents/${AGENT_ID}/session`, {
      title: "e2e linear fix",
    });
    sessionId = session.id as string;
    if (!sessionId) throw new Error("session create returned no id");
    await waitForReady(sessionId, 30_000);
  });

  // -------------------------------------------------------------------------
  // Test 1: session creates and sandbox tools are available
  // -------------------------------------------------------------------------
  test("1. session creates and sandbox tools are available", async () => {
    const session = await apiGet(`sessions/${sessionId}`);
    expect(session.status).toBe("ready");
    expect(session.harness_session_id).toBeDefined();

    const reply = await sendMessage(
      sessionId,
      `List your available tools as JSON: {"tools": ["tool1", ...]}`,
    );
    expect(reply).toMatch(/provision/i);
    expect(reply).toMatch(/execute/i);
  }, TURN_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // Test 2: agent can provision a sandbox
  // -------------------------------------------------------------------------
  test("2. agent can provision a sandbox", async () => {
    const res = await fetch(
      `${BASE_URL}/api/v1/managed_agents/sessions/${sessionId}/sandbox/provision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${MASTER_KEY}`,
        },
        body: JSON.stringify({ name: "test-sandbox", project_id: PROJECT_ID }),
      },
    );
    expect(
      res.status,
      `provision responded with ${res.status}`,
    ).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    const message = (json.message as string | undefined) ?? "";
    expect(message.toLowerCase()).toMatch(/ready/i);
  }, TURN_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // Test 3: agent can execute in the sandbox
  // -------------------------------------------------------------------------
  test("3. agent can execute in the sandbox", async () => {
    const res = await fetch(
      `${BASE_URL}/api/v1/managed_agents/sessions/${sessionId}/sandbox/execute`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${MASTER_KEY}`,
        },
        body: JSON.stringify({
          sandbox_name: "test-sandbox",
          cmd: "echo hello-from-sandbox && node --version",
        }),
      },
    );
    expect(
      res.status,
      `execute responded with ${res.status}`,
    ).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    const output = (json.output as string | undefined) ?? "";
    expect(output).toContain("hello-from-sandbox");
    // node --version prints something like "v20.11.0"
    expect(output).toMatch(/v\d+/);
  }, TURN_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // Test 4: agent reproduces and fixes LIT-3210
  // -------------------------------------------------------------------------
  test("4. agent reproduces and fixes LIT-3210", async () => {
    const reply = await sendMessage(
      sessionId,
      `Fix this Linear ticket: https://linear.app/litellm-ai/issue/LIT-3210/modelnew-or-modeldelete-operations-without-user-id

Steps:
1. Use the Linear MCP tool to read the ticket details
2. Provision a sandbox named "lit3210" using project_id "${PROJECT_ID}"
3. Reproduce the bug by running the relevant test or curl command
4. Fix the code
5. Run the test again to confirm the fix
6. Take a screenshot of the passing test output using the screenshot tool if available, otherwise output the test result as text

Reply with: DONE: <one-line summary of what you changed>`,
    );

    expect(reply).toMatch(/DONE:/i);
    expect(reply.toLowerCase()).not.toMatch(/provision failed|execute failed/i);
  }, LONG_TURN_TIMEOUT_MS);
});
