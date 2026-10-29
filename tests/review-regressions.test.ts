import { describe, expect, it } from "vitest";
import { CONFIG, runAgent } from "../src/agent";
import { MockApiClient } from "../src/client";
import {
  BOOK_GOAL,
  bookingPlanner,
  makeWorld,
  run,
  type WorldOpts,
} from "./fakeWorld";

const SEARCH_GOAL = "Find a flight from Lisbon to Tokyo on 2026-11-03.";
const searchPlanner: WorldOpts["planner"] = (r) =>
  r.some((x) => x.tool === "search_flights" && !x.result.error)
    ? { content: "Here are the flights." }
    : {
        tool: "search_flights",
        args: { origin: "Lisbon", dest: "Tokyo", date: "2026-11-03" },
      };
const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => new Response(JSON.stringify(body), { status, headers });
const pathname = (url: unknown) => new URL(String(url)).pathname;

describe("regressions from the independent review", () => {
  it("generates one run seed when the caller does not supply one", async () => {
    const w = makeWorld({ planner: searchPlanner });
    const seen: unknown[] = [];
    const fetchImpl = (async (u, i) => {
      const url = new URL(String(u));
      const body = i?.body ? JSON.parse(String(i.body)) : {};
      seen.push(
        url.pathname.endsWith("/chat")
          ? body.seed
          : url.searchParams.get("seed"),
      );
      return w.fetchImpl(u, i);
    }) as typeof fetch;
    const r = await runAgent(
      { goal: SEARCH_GOAL, autoConfirm: true, trace: () => {} },
      { fetchImpl },
    );
    expect(r.status).toBe("success");
    expect(typeof seen[0]).toBe("string");
    expect(new Set(seen).size).toBe(1);
  });
  it("preserves timeout classification and request ID when response-body reading fails", async () => {
    const fetchImpl = (async () => ({
      status: 200,
      headers: new Headers({ "x-request-id": "body-timeout" }),
      json: async () => {
        throw Object.assign(new Error("body timed out"), {
          name: "TimeoutError",
        });
      },
    })) as unknown as typeof fetch;
    const client = new MockApiClient({
      baseUrl: "https://mock.invalid",
      apiKey: "unused",
      fetchImpl,
    });
    await expect(client.listBookings()).rejects.toMatchObject({
      name: "TimeoutError",
      request_id: "body-timeout",
      status: 200,
    });
  });
  it("honours Retry-After longer than 30 seconds without clamping", async () => {
    const w = makeWorld({
      planner: searchPlanner,
      toolFault: (t, n) =>
        t === "search_flights" && n === 0
          ? { status: 429, headers: { "retry-after": "45" } }
          : undefined,
    });
    const out = await run(SEARCH_GOAL, w);
    expect(out.result.status).toBe("success");
    expect(out.sleeps).toEqual([45_000]);
  });
  it("stops instead of retrying early when Retry-After cannot fit", async () => {
    const w = makeWorld({
      planner: searchPlanner,
      chatFault: () => ({ status: 429, headers: { "retry-after": "120" } }),
    });
    const out = await run(SEARCH_GOAL, w);
    expect(out.result.status).toBe("partial");
    expect(out.sleeps).toEqual([]);
    expect(w.state.counts.bookings).toBe(0);
  });
  it("handles Retry-After HTTP dates", async () => {
    const w = makeWorld({
      planner: searchPlanner,
      toolFault: (t, n) =>
        t === "search_flights" && n === 0
          ? {
              status: 429,
              headers: { "retry-after": new Date(1_002_000).toUTCString() },
            }
          : undefined,
    });
    const out = await run(SEARCH_GOAL, w);
    expect(out.sleeps).toEqual([2000]);
    expect(out.result.status).toBe("success");
  });
  it.each([
    "Find a flight from Porto to Oslo on 2026-11-18 for Maria Silva.",
    "Find a flight from Porto to Oslo on 2026-11-18 for Maria Silva. Don't book it.",
  ])(
    "never books for an information-only or explicitly negated goal: %s",
    async (goal) => {
      const w = makeWorld({ planner: bookingPlanner });
      const out = await run(goal, w);
      expect(w.state.bookBodies).toEqual([]);
      expect(out.result.bookings).toEqual([]);
      expect(out.result.errors.some((e) => e.code === "booking_blocked")).toBe(
        true,
      );
    },
  );
  it("rejects a planner search for the wrong route and date before any write", async () => {
    const w = makeWorld({
      planner: (r, m, n) => {
        const p = bookingPlanner(r, m, n);
        return p.tool === "search_flights"
          ? {
              ...p,
              args: { origin: "Lisbon", dest: "Tokyo", date: "2026-11-03" },
            }
          : p;
      },
    });
    const out = await run(BOOK_GOAL, w);
    expect(out.result.status).not.toBe("success");
    expect(w.state.bookBodies).toEqual([]);
    expect(out.result.errors.some((e) => e.code === "goal_mismatch")).toBe(
      true,
    );
  });
  it("rejects search response metadata that does not match the requested route", async () => {
    const w = makeWorld({ planner: bookingPlanner });
    const orig = w.fetchImpl;
    const fetchImpl = (async (u, i) => {
      const r = await orig(u, i);
      if (pathname(u).endsWith("/search_flights")) {
        const body = (await r.json()) as { results: { destination: string }[] };
        body.results[0].destination = "Somewhere Else";
        return json(body);
      }
      return r;
    }) as typeof fetch;
    const out = await run(BOOK_GOAL, { ...w, fetchImpl });
    expect(out.result.status).not.toBe("success");
    expect(w.state.bookBodies).toEqual([]);
  });
  it("does not accept a passenger name that is only a substring of the requested name", async () => {
    const w = makeWorld({
      planner: (r, m, n) => {
        const p = bookingPlanner(r, m, n);
        return p.tool === "book_flight"
          ? { ...p, args: { flight_id: "FL-B", passenger: "Maria" } }
          : p;
      },
    });
    await run(BOOK_GOAL, w);
    expect(w.state.bookBodies).toEqual([]);
  });
  it("enforces a requested price budget", async () => {
    const w = makeWorld({ planner: bookingPlanner });
    const out = await run(
      BOOK_GOAL.replace(" for Maria Silva.", " under EUR 100 for Maria Silva."),
      w,
    );
    expect(w.state.bookBodies).toEqual([]);
    expect(out.result.status).not.toBe("success");
  });
  it("stops immediately after an over-budget final answer", async () => {
    const w = makeWorld({
      planner: (r, m, n) => ({
        ...searchPlanner(r, m, n),
        tokens: r.length ? CONFIG.maxTokens + 1 : 100,
      }),
    });
    const out = await run(SEARCH_GOAL, w);
    expect(out.result.status).toBe("partial");
    expect(out.result.cost).toBeGreaterThan(CONFIG.maxTokens);
    expect(
      out.result.errors.some((e) => e.code === "cost_budget_exceeded"),
    ).toBe(true);
  });
  it("does not dispatch a booking produced by an over-budget planner response", async () => {
    const w = makeWorld({
      planner: (r, m, n) => ({
        ...bookingPlanner(r, m, n),
        tokens: r.length ? CONFIG.maxTokens : 100,
      }),
    });
    const out = await run(BOOK_GOAL, w);
    expect(out.result.status).toBe("partial");
    expect(w.state.bookBodies).toEqual([]);
  });
  it("propagates the seed and logs the request ID for every HTTP response", async () => {
    const w = makeWorld({ planner: bookingPlanner });
    const orig = w.fetchImpl;
    const requests: { path: string; seeded: boolean }[] = [];
    const fetchImpl = (async (u, i) => {
      const url = new URL(String(u));
      const body = i?.body ? JSON.parse(String(i.body)) : {};
      requests.push({
        path: url.pathname,
        seeded: url.pathname.endsWith("/chat")
          ? body.seed === "t"
          : url.searchParams.get("seed") === "t",
      });
      const r = await orig(u, i);
      r.headers.set("x-request-id", `request-${requests.length}`);
      return r;
    }) as typeof fetch;
    const out = await run(BOOK_GOAL, { ...w, fetchImpl });
    expect(out.result.status).toBe("success");
    expect(requests.every((r) => r.seeded)).toBe(true);
    expect(
      out.traceLines.filter((t) => typeof t.request_id === "string"),
    ).toHaveLength(requests.length);
    expect(out.traceLines.every((t) => Number(t.step) >= 1)).toBe(true);
  });
  it("reconciles after search-only runs and fatal planner errors", async () => {
    for (const fail of [false, true]) {
      const w = makeWorld({
        planner: searchPlanner,
        chatFault: fail ? () => ({ status: 403 }) : undefined,
      });
      const out = await run(SEARCH_GOAL, w);
      expect(w.state.counts.bookings).toBe(0);
      expect(
        out.traceLines.some(
          (t) => t.action === "bookings.reconcile" && t.outcome === "ok",
        ),
      ).toBe(true);
    }
  });
  it("bounds work and repeated reconciliation failures below the harness deadline", async () => {
    let clock = 1_000_000,
      lists = 0,
      writes = 0;
    const w = makeWorld({ planner: bookingPlanner });
    const fetchImpl = (async (u, i) => {
      const path = pathname(u);
      if (path.endsWith("/book_flight")) {
        writes++;
        clock += 10_000;
        throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      }
      if (path.endsWith("/bookings")) {
        lists++;
        if (lists >= 7) {
          clock += 10_000;
          throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
        }
      } else clock += 1000;
      return w.fetchImpl(u, i);
    }) as typeof fetch;
    const result = await runAgent(
      { goal: BOOK_GOAL, seed: "t", autoConfirm: true, trace: () => {} },
      {
        fetchImpl,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        random: () => 1,
      },
    );
    expect(result.status).toBe("partial");
    expect(writes).toBe(5);
    expect(clock - 1_000_000).toBeLessThanOrEqual(CONFIG.totalWallMs);
    expect(clock - 1_000_000).toBeLessThan(120_000);
  });
  it("does not write after the deadline expires during confirmation", async () => {
    let clock = 1_000_000;
    const w = makeWorld({ planner: bookingPlanner });
    const result = await runAgent(
      { goal: BOOK_GOAL, seed: "t", autoConfirm: false, trace: () => {} },
      {
        fetchImpl: w.fetchImpl,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        random: () => 1,
        confirm: async () => {
          clock += CONFIG.maxWallMs;
          return true;
        },
      },
    );
    expect(result.status).toBe("partial");
    expect(w.state.bookBodies).toEqual([]);
  });
  it("reports partial and avoids claiming final verification when bookings cannot be read", async () => {
    let reads = 0;
    const w = makeWorld({ planner: bookingPlanner });
    const orig = w.fetchImpl;
    const fetchImpl = (async (u, i) => {
      if (pathname(u).endsWith("/bookings") && ++reads > 1)
        return json({ error: { message: "Unavailable" } }, 503);
      return orig(u, i);
    }) as typeof fetch;
    const out = await run(BOOK_GOAL, { ...w, fetchImpl });
    expect(out.result.status).toBe("partial");
    expect(out.result.answer).toContain("final verification unavailable");
    expect(out.result.answer).not.toContain("confirmed on the server");
  });
  it("reconciles a committed write after recovery reads fail, without another write", async () => {
    let reads = 0,
      writes = 0;
    const w = makeWorld({ planner: bookingPlanner });
    const orig = w.fetchImpl;
    const fetchImpl = (async (u, i) => {
      const path = pathname(u);
      if (path.endsWith("/book_flight")) {
        writes++;
        await orig(u, i);
        throw Object.assign(new Error("lost reply"), { name: "TimeoutError" });
      }
      if (path.endsWith("/bookings") && ++reads >= 2 && reads <= 4)
        return json({ error: { message: "Unavailable" } }, 503);
      return orig(u, i);
    }) as typeof fetch;
    const out = await run(BOOK_GOAL, { ...w, fetchImpl });
    expect(out.result.status).toBe("partial");
    expect(writes).toBe(1);
    expect(w.state.bookings).toHaveLength(1);
    expect(out.result.bookings).toHaveLength(1);
  });
  it("accepts a stale observation dated yesterday, refetches once and reports freshness", async () => {
    const goal =
      "Find a flight from Lisbon to Tokyo on 2026-11-03 and check the weather in Tokyo.";
    const planner: WorldOpts["planner"] = (r, m, n) =>
      !r.some((x) => x.tool === "search_flights")
        ? searchPlanner(r, m, n)
        : !r.some((x) => x.tool === "get_weather")
          ? { tool: "get_weather", args: { city: "Tokyo", date: "2026-11-03" } }
          : { content: "Flights and weather are ready." };
    const w = makeWorld({ planner });
    const orig = w.fetchImpl;
    let count = 0;
    const fetchImpl = (async (u, i) => {
      const r = await orig(u, i);
      if (!pathname(u).endsWith("/get_weather")) return r;
      const body = (await r.json()) as { stale: boolean; date: string };
      if (++count === 1) {
        body.stale = true;
        body.date = "2026-11-02";
      }
      return json(body);
    }) as typeof fetch;
    const out = await run(goal, { ...w, fetchImpl });
    expect(out.result.status).toBe("success");
    expect(count).toBe(2);
    expect(out.result.answer).toContain("refetched once");
  });
});
