export type MicaValidationCode =
  | 'invalid_value'
  | 'invalid_type'
  | 'missing_field'
  | 'unknown_field'
  | 'immutable_field'
  | 'conflicting_paths'
  | 'unsupported_operation'
  | 'invalid_option'
  | 'invalid_update'
  | 'invalid_projection'
  | 'invalid_map_key';

/** A Mica input-validation failure. Driver and user codec errors retain their identity. */
export class MicaValidationError extends Error {
  readonly name = 'MicaValidationError';

  constructor(
    readonly code: MicaValidationCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}
