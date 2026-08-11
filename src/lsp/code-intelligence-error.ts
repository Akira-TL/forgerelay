export class CodeIntelligenceError extends Error {
  constructor(
    readonly code:
      | "code.language_service_unavailable"
      | "code.language_service_start_failed"
      | "code.language_service_start_timeout"
      | "code.configuration_ambiguous"
      | "code.configuration_invalid"
      | "code.operation_unsupported"
      | "code.request_timeout"
      | "code.request_cancelled"
      | "code.request_capacity"
      | "code.server_crashed"
      | "code.invalid_position"
      | "code.result_outside_policy"
      | "code.language_service_capacity",
    message: string,
  ) {
    super(message);
    this.name = "CodeIntelligenceError";
  }
}
