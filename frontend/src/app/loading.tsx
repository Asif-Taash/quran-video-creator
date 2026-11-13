import Spinner from "@/components/ui/Spinner";

export default function Loading() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background transition-colors duration-300">
      <Spinner size="lg" />
      <p className="text-sm text-muted-foreground animate-fade-in">Kuran Nuru</p>
    </div>
  );
}
