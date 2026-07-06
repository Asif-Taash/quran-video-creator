import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { prompt } = await req.json();
    if (!prompt) {
      return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
    }

    console.log(`[AI Background] Generating image with prompt: "${prompt}" using Pollinations AI`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000); // 90-second timeout (images can take a while)

    let response: Response | null = null;
    let retries = 3;
    let delay = 1000;

    try {
      const encodedPrompt = encodeURIComponent(prompt);
      // Adding a random seed parameter helps Pollinations bypass cache properly
      const randomSeed = Math.floor(Math.random() * 1000000);
      const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1080&height=1920&model=flux-realism&nologo=true&enhance=true&seed=${randomSeed}`;
      
      while (retries > 0) {
        response = await fetch(url, {
          method: "GET",
          signal: controller.signal,
        });

        if (response.status === 429) {
          console.log(`[AI Background] Rate limited (429). Retrying in ${delay}ms... (${retries} retries left)`);
          await new Promise(r => setTimeout(r, delay));
          retries--;
          delay += 1500; // exponential backoff
          continue;
        }
        
        break;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!response || !response.ok) {
      const status = response ? response.status : 500;
      const text = response ? await response.text().catch(() => "") : "Max retries reached";
      console.error(`[AI Background] API Error (${status}):`, text);
      return NextResponse.json(
        { error: `API request failed with status ${status}. Please wait a few seconds and try again.` },
        { status: status === 429 ? 429 : 500 }
      );
    }

    // Ensure the response is an image
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.startsWith("image/")) {
       const text = await response.text().catch(() => "");
       console.error(`[AI Background] Expected image but got ${contentType}:`, text);
       return NextResponse.json({ error: "API did not return an image." }, { status: 500 });
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Ensure directory exists
    const uploadsDir = path.join(process.cwd(), "public", "render-assets", "generated-bg");
    await fs.mkdir(uploadsDir, { recursive: true });

    // Save image
    const extension = contentType === "image/png" ? ".png" : contentType === "image/webp" ? ".webp" : ".jpg";
    const filename = `bg-ai-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`;
    const absolutePath = path.join(uploadsDir, filename);
    await fs.writeFile(absolutePath, buffer);

    const imageUrl = `/render-assets/generated-bg/${filename}`;
    
    console.log(`[AI Background] Generated image successfully: ${imageUrl}`);

    return NextResponse.json({ success: true, imageUrl });
  } catch (error) {
    console.error("[AI Background] Error generating background:", error);
    return NextResponse.json(
      { error: "Failed to generate background image due to an internal error or timeout." },
      { status: 500 }
    );
  }
}
