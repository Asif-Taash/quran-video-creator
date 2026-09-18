import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export async function POST() {
  try {
    const tempFilePath = path.join(process.cwd(), "src", "data", "temp_segmentation.json");
    
    try {
      await fs.access(tempFilePath);
      await fs.unlink(tempFilePath);
    } catch {
      // File doesn't exist, ignore
    }

    return NextResponse.json({ success: true, message: "Segmentation data cleared successfully." });
  } catch (error) {
    console.error("Segmentation clear API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to clear segmentation data" },
      { status: 500 }
    );
  }
}
