import Navbar from "@/components/layout/Navbar";
import type { Metadata } from "next";
import VideoCreatorForm from "@/components/video-creator/VideoCreatorForm";

export const metadata: Metadata = {
  title: "Kuran Nuru",
  description: "Kuran Nuru",
};

export default function VideoCreatorPage() {
  return (
    <div className="min-h-screen bg-background transition-colors duration-300">
      <Navbar />
      <main className="px-4 py-12 md:py-16">
        <VideoCreatorForm />
      </main>
    </div>
  );
}
