import { VideoValidationRequestedDto } from '../messaging/dto/video-validation-requested.dto';

/**
 * The closed vocabulary of safe failure codes, fixed by `docs/foudation.md`.
 *
 * Duplicated deliberately in each service rather than shared through a
 * package: the services communicate over documented JSON and own their local
 * DTOs. The Catalog rejects any code outside this set.
 */
export type FailureCode =
  'FORMATO_INVALIDO' | 'DURACAO_EXCEDIDA' | 'PROCESSAMENTO_FALHOU';

export type ValidationOutcome =
  { accepted: true } | { accepted: false; failureCode: FailureCode };

/**
 * Decides whether a source video may be processed, without saying how that is
 * determined. S4 implements this with FFprobe; until then the only
 * implementation accepts everything.
 */
export interface VideoValidator {
  validate(job: VideoValidationRequestedDto): Promise<ValidationOutcome>;
}

export const VIDEO_VALIDATOR = 'VIDEO_VALIDATOR';
