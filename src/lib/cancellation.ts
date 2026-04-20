export class CancelledError extends Error {
  constructor() {
    super("작업이 취소되었습니다.");
    this.name = "CancelledError";
  }
}

export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}
