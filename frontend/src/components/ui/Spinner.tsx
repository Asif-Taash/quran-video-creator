interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<SpinnerProps["size"]>, string> = {
  sm: "h-3.5 w-3.5 border-2",
  md: "h-5 w-5 border-2",
  lg: "h-8 w-8 border-[3px]",
};

// One shared gold spinner used everywhere a loading state needs a visual
// indicator, replacing several previously-duplicated inline <svg animate-spin>
// blocks and a couple of one-off ad hoc spinner styles across the app.
export default function Spinner({ size = "md", className = "" }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="loading"
      className={`inline-block flex-shrink-0 animate-spin rounded-full border-primary/25 border-t-primary ${SIZE_CLASSES[size]} ${className}`}
    />
  );
}
