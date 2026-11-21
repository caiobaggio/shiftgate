export class HttpError extends Error {
  status: number;
  code: string;
  eventId?: string;

  constructor(status: number, code: string, message: string, eventId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.eventId = eventId;
  }
}

export function httpError(status: number, code: string, message: string, eventId?: string): HttpError {
  return new HttpError(status, code, message, eventId);
}
