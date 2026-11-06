import { ReceiptScanResponseSchema } from '@pfm/contracts';

export async function scanReceipt(
  imageBase64: string,
  baseUrl: string,
  deviceId: string,
  fetchImpl: typeof fetch = fetch,
) {
  if ((typeof __DEV__ === 'undefined' || !__DEV__) && !baseUrl.startsWith('https://'))
    throw new Error('Cần kết nối HTTPS để gửi ảnh hóa đơn.');
  const response = await fetchImpl(`${baseUrl}/v1/receipts/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-id': deviceId },
    body: JSON.stringify({ mimeType: 'image/jpeg', imageBase64 }),
  });
  if (!response.ok) {
    let message = 'Không thể đọc hóa đơn. Vui lòng thử lại hoặc nhập tay.';
    try {
      const error = await response.json() as { message?: unknown };
      if (typeof error.message === 'string' && error.message.length <= 200)
        message = error.message;
    } catch { /* Keep the local error message. */ }
    throw new Error(message);
  }
  return ReceiptScanResponseSchema.parse(await response.json());
}
