export class FinanceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "FinanceError";
  }
}

export function financeBadRequest(message: string, code = "FINANCE_BAD_REQUEST") {
  return new FinanceError(message, 400, code);
}

export function financeNotFound(message: string, code = "FINANCE_NOT_FOUND") {
  return new FinanceError(message, 404, code);
}

export function financeConflict(message: string, code = "FINANCE_CONFLICT") {
  return new FinanceError(message, 409, code);
}
