export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly fallbackTemplate?: string;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    fallbackTemplate?: string,
    isOperational = true,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.fallbackTemplate = fallbackTemplate;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message: string, code = 'BAD_REQUEST'): AppError {
    return new AppError(400, code, message);
  }

  static outOfScope(
    message = 'Nội dung câu hỏi nằm ngoài phạm vi tư vấn tài chính cá nhân được hỗ trợ.',
  ): AppError {
    return new AppError(422, 'ADVICE_OUT_OF_SCOPE', message);
  }

  static restricted(
    message = 'Hệ thống không đưa ra khuyến nghị sản phẩm, ngân hàng, công ty chứng khoán hoặc bên cho vay cụ thể.',
  ): AppError {
    return new AppError(422, 'ADVICE_RESTRICTED', message);
  }

  static ambiguous(
    message = 'Chưa rõ ngữ cảnh tài chính hoặc ý định tư vấn không khớp với nội dung câu hỏi.',
    code: 'ADVICE_AMBIGUOUS' | 'BAD_REQUEST' = 'ADVICE_AMBIGUOUS',
  ): AppError {
    return new AppError(422, code, message);
  }

  static piiDetected(
    message = 'Câu hỏi có vẻ chứa thông tin cá nhân. Vui lòng xóa và hỏi lại.',
  ): AppError {
    return new AppError(400, 'PII_DETECTED', message);
  }

  static rateLimitExceeded(
    message = 'Quá nhiều yêu cầu từ địa chỉ IP của bạn. Vui lòng thử lại sau ít phút.',
  ): AppError {
    return new AppError(429, 'RATE_LIMIT_EXCEEDED', message);
  }

  static quotaExceeded(
    message: string,
    code: 'QUOTA_EXCEEDED_DEVICE' | 'QUOTA_EXCEEDED_GLOBAL' = 'QUOTA_EXCEEDED_DEVICE',
    fallbackTemplate?: string,
  ): AppError {
    return new AppError(429, code, message, fallbackTemplate);
  }

  static upstreamUnavailable(
    message = 'Hiện chưa có câu trả lời từ trợ lý AI. Dưới đây là kết quả tính toán từ dữ liệu của bạn.',
    fallbackTemplate?: string,
  ): AppError {
    return new AppError(503, 'UPSTREAM_UNAVAILABLE', message, fallbackTemplate);
  }

  static answerUnverified(
    message = 'Câu trả lời từ trợ lý AI chưa được xác thực số liệu an toàn. Dưới đây là kết quả tính toán từ dữ liệu của bạn.',
    fallbackTemplate?: string,
  ): AppError {
    return new AppError(422, 'ANSWER_UNVERIFIED', message, fallbackTemplate);
  }

  static internal(
    message = 'Đã xảy ra lỗi nội bộ máy chủ.',
    code = 'INTERNAL_ERROR',
  ): AppError {
    return new AppError(500, code, message, undefined, false);
  }
}
