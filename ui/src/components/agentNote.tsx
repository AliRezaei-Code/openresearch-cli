/** Harness `agentNote` strings carry the command to run in backticks
 * (`claude auth login`) — render those spans as code so they read as something
 * to type, not prose. Shared by every surface that shows a note: onboarding,
 * the model picker, and settings. */
export function renderNote(note: string | undefined) {
  if (!note) return null;
  return note.split(/`([^`]+)`/).map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="mono">
        {part}
      </code>
    ) : (
      part
    ),
  );
}
