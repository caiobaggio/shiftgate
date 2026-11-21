import { useEffect, useId, useRef, useState } from "react";

export function Hint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <span className="hint" ref={ref}>
      <button
        type="button"
        className="hint-mark"
        aria-expanded={open}
        aria-controls={id}
        aria-label="De onde vem este dado"
        onClick={() => setOpen((value) => !value)}
      >
        ?
      </button>
      {open && (
        <span className="hint-pop" id={id} role="note">
          {text}
        </span>
      )}
    </span>
  );
}
