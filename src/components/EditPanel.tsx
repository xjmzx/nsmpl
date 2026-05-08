import { Crop, Volume2, Wand2 } from "lucide-react";
import { Section } from "./Section";

export function EditPanel() {
  return (
    <Section title="Edit" icon={<Wand2 size={16} />}>
      <p className="text-xs text-muted">
        Trim, fade, normalize. Edits run in-app via the Web Audio API and
        export through ffmpeg invoked from the Rust side.
      </p>

      <div className="grid grid-cols-3 gap-2 mt-1">
        <button className="px-3 py-2 rounded-md bg-surface hover:bg-surfaceHover
                           text-fg flex items-center justify-center gap-1.5" disabled>
          <Crop size={14} /> Trim
        </button>
        <button className="px-3 py-2 rounded-md bg-surface hover:bg-surfaceHover
                           text-fg flex items-center justify-center gap-1.5" disabled>
          <Volume2 size={14} /> Fade
        </button>
        <button className="px-3 py-2 rounded-md bg-surface hover:bg-surfaceHover
                           text-fg flex items-center justify-center gap-1.5" disabled>
          <Wand2 size={14} /> Normalize
        </button>
      </div>
    </Section>
  );
}
