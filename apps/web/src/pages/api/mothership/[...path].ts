import type { NextApiRequest, NextApiResponse } from "next";
import { fromNodeHeaders } from "better-auth/node";

import { withRateLimit } from "@kan/api/utils/rateLimit";
import { initAuth } from "@kan/auth/server";
import { createDrizzleClient } from "@kan/db/client";

/**
 * cachly: Session-gated Proxy zum Mothership (hookd auf dem Host).
 *
 * Die Mothership-Oberflaechen (Puls/Wissen) laufen als eigener Daemon
 * ausserhalb von Kan. Diese Route macht sie fuer eingeloggte Kan-User
 * OHNE zweites Login verfuegbar: Kan-Session pruefen, dann serverseitig
 * zu MOTHERSHIP_BASE_URL weiterreichen (Allowlist, kein offener Proxy).
 */
const auth = initAuth(createDrizzleClient());

const ALLOWED: Record<string, string> = {
  puls: "/puls",
  "puls/data": "/puls/data",
  "puls/ask": "/puls/ask",
  "puls/insights": "/puls/insights",
  "puls/action": "/puls/action",
  karte: "/karte",
  faelle: "/faelle",
  "faelle/data": "/faelle/data",
  wissen: "/wissen",
  "wissen/data": "/wissen/data",
  "wissen/graph": "/wissen/graph",
};

export default withRateLimit(
  { points: 120, duration: 60 },
  async (req: NextApiRequest, res: NextApiResponse) => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session?.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const base = process.env.MOTHERSHIP_BASE_URL;
    if (!base) {
      return res.status(503).json({ message: "Mothership not configured" });
    }

    const parts = (req.query.path as string[] | undefined) ?? [];
    const target = ALLOWED[parts.join("/")];
    if (!target) {
      return res.status(404).json({ message: "Not found" });
    }

    const qs = req.url?.includes("?") ? "?" + (req.url.split("?")[1] ?? "") : "";
    try {
      const upstream = await fetch(base + target + qs, {
        method: req.method,
        headers: {
          "Content-Type":
            (req.headers["content-type"] as string | undefined) ??
            "application/json",
        },
        body:
          req.method === "POST" ? JSON.stringify(req.body ?? {}) : undefined,
      });
      res
        .status(upstream.status)
        .setHeader(
          "Content-Type",
          upstream.headers.get("content-type") ?? "text/plain",
        );
      return res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      return res.status(502).json({ message: "Mothership unreachable" });
    }
  },
);
