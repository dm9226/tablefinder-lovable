import { useState, useEffect, useRef } from "react";
import { X } from "lucide-react";

const REAL_STAGES = [
  "Understanding your request…",
  "Searching Resy, OpenTable & Yelp…",
  "Verifying real-time availability…",
  "Confirming available tables…",
  "Finalizing results…",
];

const FUNNY_FILLERS = [
  "Getting distracted by pumas…",
  "Folding socks…",
  "Arguing with a sommelier…",
  "Ironing the tablecloths…",
  "Teaching a goldfish to parallel park…",
  "Alphabetizing the spice rack…",
  "Convincing a cat to cooperate…",
  "Polishing the silverware…",
  "Asking the magic 8-ball…",
  "Reheating yesterday's pasta…",
  "Untangling fairy lights…",
  "Practicing chopstick skills…",
  "Whispering to houseplants…",
  "Counting ceiling tiles…",
  "Debating pineapple on pizza…",
  "Searching for matching Tupperware lids…",
  "Apologizing to the sourdough starter…",
  "High-fiving a cactus…",
  "Explaining WiFi to a pigeon…",
  "Rehearsing a dramatic entrance…",
  "Consulting the cheese wheel…",
  "Negotiating with a squirrel…",
  "Fluffing the dinner rolls…",
  "Befriending a roomba…",
  "Judging a pancake flip contest…",
  "Organizing rubber ducks…",
  "Writing a haiku about breadsticks…",
  "Meditating with a burrito…",
  "Asking a pelican for directions…",
  "Tuning the kazoo orchestra…",
];

function pickRandomFillers(count: number): string[] {
  const shuffled = [...FUNNY_FILLERS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function buildStages(): { label: string; duration: number }[] {
  const fillers = pickRandomFillers(3);
  // Interleave: real, filler, real, filler, real, filler, real, real
  return [
    { label: REAL_STAGES[0], duration: 2000 },
    { label: REAL_STAGES[1], duration: 3000 },
    { label: fillers[0], duration: 1500 },
    { label: REAL_STAGES[2], duration: 4000 },
    { label: fillers[1], duration: 1500 },
    { label: REAL_STAGES[3], duration: 3000 },
    { label: fillers[2], duration: 1500 },
    { label: REAL_STAGES[4], duration: 2000 },
  ];
}

interface SearchProgressProps {
  onCancel: () => void;
}

export function SearchProgress({ onCancel }: SearchProgressProps) {
  const [stageIndex, setStageIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const stagesRef = useRef(buildStages());
  const stages = stagesRef.current;

  useEffect(() => {
    const totalDuration = stages.reduce((a, s) => a + s.duration, 0);
    let elapsed = 0;

    const interval = setInterval(() => {
      elapsed += 50;
      const pct = Math.min((elapsed / totalDuration) * 95, 95);
      setProgress(pct);

      let acc = 0;
      for (let i = 0; i < stages.length; i++) {
        acc += stages[i].duration;
        if (elapsed < acc) {
          setStageIndex(i);
          break;
        }
        if (i === stages.length - 1) setStageIndex(i);
      }
    }, 50);

    return () => clearInterval(interval);
  }, [stages]);

  const stage = stages[stageIndex];

  return (
    <div className="flex flex-col items-center justify-center py-20 gap-5 animate-fade-in">
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

      <p className="text-muted-foreground font-body text-sm transition-all duration-300">
        {stage.label}
      </p>

      <div className="w-48 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-200 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

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
