import { NextResponse } from "next/server";
import { configuredProviders } from "@/lib/stockBackgrounds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Whether the background picker should offer the stock library at all --
// it stays hidden (upload-only) until a provider key is configured.
export async function GET() {
  return NextResponse.json({ enabled: configuredProviders().length > 0 });
}
