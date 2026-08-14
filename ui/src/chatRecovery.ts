export interface RetryMetadata {
  retryOwner?: "native" | "orx";
  attempt?: number;
  maximum?: number | null;
  nextRetryAt?: number | null;
}

export function retryStatusLabel(input: RetryMetadata, now: number): string {
  const seconds = typeof input.nextRetryAt === "number"
    ? Math.max(0, Math.ceil((input.nextRetryAt - now) / 1000))
    : null;
  if (input.retryOwner === "native" && input.maximum == null && seconds == null) {
    return "CLI is retrying…";
  }
  return [
    "Retrying",
    typeof input.attempt === "number" && typeof input.maximum === "number"
      ? `attempt ${input.attempt}/${input.maximum}`
      : null,
    seconds == null ? null : `next attempt in ${seconds}s`,
  ].filter(Boolean).join(" · ");
}

export function recoveryAction(
  action: unknown,
): "retry" | "continue" | null {
  return action === "retry" || action === "continue" ? action : null;
}

export interface RecoveryOverrides {
  model?: string;
  permissionMode?: string;
  planMode?: boolean;
  reasoningLevel?: string;
}

export function recoveryTurnOptions(overrides: RecoveryOverrides): RecoveryOverrides {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
}
