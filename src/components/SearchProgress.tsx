import { useState, useEffect } from "react";
import { X } from "lucide-react";

const STAGES = [
  { label: "Understanding your request…", duration: 2000 },
  { label: "Searching Resy, OpenTable & Yelp…", duration: 4000 },
  { label: "Verifying real-time availability…", duration: 6000 },
  { label: "Confirming available tables…", duration: 5000 },
  { label: "Finalizing results…", duration: 3000 },
];

interface SearchProgressProps {
  onCancel: () => void;
}

export function SearchProgress({ onCancel }: SearchProgressProps) {
  const [stageIndex, setStageIndex] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const totalDuration = STAGES.reduce((a, s) => a + s.duration, 0);
    let elapsed = 0;

    const interval = setInterval(() => {
      elapsed += 50;
      const pct = Math.min((elapsed / totalDuration) * 95, 95); // never hit 100% until done
      setProgress(pct);

      // Determine current stage
      let acc = 0;
      for (let i = 0; i < STAGES.length; i++) {
        acc += STAGES[i].duration;
        if (elapsed < acc) {
          setStageIndex(i);
          break;
        }
        if (i === STAGES.length - 1) setStageIndex(i);
      }
    }, 50);

    return () => clearInterval(interval);
  }, []);

  const stage = STAGES[stageIndex];

  return (
    <div className="flex flex-col items-center justify-center py-20 gap-5 animate-fade-in">
      {/* Animated dots */}
      <div className="flex items-center gap-1.5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-2.5 w-2.5 rounded-full bg-primary"
            style={{
              animation: `pulse 1.4s ease-in-out ${i * 0.2}s infinite`,
              opacity: 0.4,
            }}
          />
        ))}
      </div>

      {/* Stage label */}
      <p className="text-muted-foreground font-body text-sm transition-all duration-300">
        {stage.label}
      </p>

      {/* Progress bar */}
      <div className="w-48 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-200 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Cancel button */}
      <button
        onClick={onCancel}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors font-body mt-2"
      >
        <X className="h-3.5 w-3.5" />
        Stop searching
      </button>
    </div>
  );
}
