/**
 * Image processing utility functions
 */

/**
 * Create ImageBitmap from data URL (for OffscreenCanvas)
 * @param dataUrl Image data URL
 * @returns Created ImageBitmap object
 */
export async function createImageBitmapFromUrl(dataUrl: string): Promise<ImageBitmap> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return await createImageBitmap(blob);
}

/**
 * Stitch multiple image parts (dataURL) onto a single canvas
 * @param parts Array of image parts, each containing dataUrl and y coordinate
 * @param totalWidthPx Total width (pixels)
 * @param totalHeightPx Total height (pixels)
 * @returns Stitched canvas
 */
export async function stitchImages(
  parts: { dataUrl: string; y: number }[],
  totalWidthPx: number,
  totalHeightPx: number,
): Promise<OffscreenCanvas> {
  const canvas = new OffscreenCanvas(totalWidthPx, totalHeightPx);
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Unable to get canvas context');
  }

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const part of parts) {
    try {
      const img = await createImageBitmapFromUrl(part.dataUrl);
      const sx = 0;
      const sy = 0;
      const sWidth = img.width;
      let sHeight = img.height;
      const dy = part.y;

      if (dy + sHeight > totalHeightPx) {
        sHeight = totalHeightPx - dy;
      }

      if (sHeight <= 0) continue;

      ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, dy, sWidth, sHeight);
    } catch (error) {
      console.error('Error stitching image part:', error, part);
    }
  }
  return canvas;
}

/**
 * Crop image (from dataURL) to specified rectangle and resize
 * @param originalDataUrl Original image data URL
 * @param cropRectPx Crop rectangle (physical pixels)
 * @param dpr Device pixel ratio
 * @param targetWidthOpt Optional target output width (CSS pixels)
 * @param targetHeightOpt Optional target output height (CSS pixels)
 * @returns Cropped canvas
 */
export async function cropAndResizeImage(
  originalDataUrl: string,
  cropRectPx: { x: number; y: number; width: number; height: number },
  dpr: number = 1,
  targetWidthOpt?: number,
  targetHeightOpt?: number,
): Promise<OffscreenCanvas> {
  const img = await createImageBitmapFromUrl(originalDataUrl);

  let sx = cropRectPx.x;
  let sy = cropRectPx.y;
  let sWidth = cropRectPx.width;
  let sHeight = cropRectPx.height;

  // Ensure crop area is within image boundaries
  if (sx < 0) {
    sWidth += sx;
    sx = 0;
  }
  if (sy < 0) {
    sHeight += sy;
    sy = 0;
  }
  if (sx + sWidth > img.width) {
    sWidth = img.width - sx;
  }
  if (sy + sHeight > img.height) {
    sHeight = img.height - sy;
  }

  if (sWidth <= 0 || sHeight <= 0) {
    throw new Error(
      'Invalid calculated crop size (<=0). Element may not be visible or fully captured.',
    );
  }

  const finalCanvasWidthPx = targetWidthOpt ? targetWidthOpt * dpr : sWidth;
  const finalCanvasHeightPx = targetHeightOpt ? targetHeightOpt * dpr : sHeight;

  const canvas = new OffscreenCanvas(finalCanvasWidthPx, finalCanvasHeightPx);
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Unable to get canvas context');
  }

  ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, finalCanvasWidthPx, finalCanvasHeightPx);

  return canvas;
}

/**
 * Convert canvas to data URL
 * @param canvas Canvas
 * @param format Image format
 * @param quality JPEG quality (0-1)
 * @returns Data URL
 */
export async function canvasToDataURL(
  canvas: OffscreenCanvas,
  format: string = 'image/png',
  quality?: number,
): Promise<string> {
  const blob = await canvas.convertToBlob({
    type: format,
    quality: format === 'image/jpeg' ? quality : undefined,
  });

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Compresses an image by scaling it and converting it to a target format with a specific quality.
 * This is the most effective way to reduce image data size for transport or storage.
 *
 * @param {string} imageDataUrl - The original image data URL (e.g., from captureVisibleTab).
 * @param {object} options - Compression options.
 * @param {number} [options.scale=1.0] - The scaling factor for dimensions (e.g., 0.7 for 70%).
 * @param {number} [options.quality=0.8] - The quality for lossy formats like JPEG (0.0 to 1.0).
 * @param {string} [options.format='image/jpeg'] - The target image format.
 * @returns {Promise<{dataUrl: string, mimeType: string}>} A promise that resolves to the compressed image data URL and its MIME type.
 */
export async function compressImage(
  imageDataUrl: string,
  options: { scale?: number; quality?: number; format?: 'image/jpeg' | 'image/webp' },
): Promise<{ dataUrl: string; mimeType: string }> {
  const { scale = 1.0, quality = 0.8, format = 'image/jpeg' } = options;

  // 1. Create an ImageBitmap from the original data URL for efficient drawing.
  const imageBitmap = await createImageBitmapFromUrl(imageDataUrl);

  // 2. Calculate the new dimensions based on the scale factor.
  const newWidth = Math.round(imageBitmap.width * scale);
  const newHeight = Math.round(imageBitmap.height * scale);

  // 3. Use OffscreenCanvas for performance, as it doesn't need to be in the DOM.
  const canvas = new OffscreenCanvas(newWidth, newHeight);
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Failed to get 2D context from OffscreenCanvas');
  }

  // 4. Draw the original image onto the smaller canvas, effectively resizing it.
  ctx.drawImage(imageBitmap, 0, 0, newWidth, newHeight);

  // 5. Export the canvas content to the target format with the specified quality.
  // This is the step that performs the data compression.
  const compressedDataUrl = await canvas.convertToBlob({ type: format, quality: quality });

  // A helper to convert blob to data URL since OffscreenCanvas.toDataURL is not standard yet
  // on all execution contexts (like service workers).
  const dataUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.readAsDataURL(compressedDataUrl);
  });

  return { dataUrl, mimeType: format };
}

/**
 * scalemaker fork: Claude 이미지 입력 최적 크기(긴 변 기준).
 * 이보다 큰 이미지를 보내도 인식률은 좋아지지 않고 토큰만 늘어난다.
 */
export const MODEL_INPUT_MAX_LONG_EDGE = 1568;

/** scalemaker fork: 모델 입력용으로 축소/압축된 이미지 정보 */
export interface ModelInputImage {
  /** 최종 data URL */
  dataUrl: string;
  /** 최종 MIME 타입 (보통 image/jpeg, PNG 가 더 작으면 image/png 유지) */
  mimeType: string;
  /** 최종 이미지 실제 픽셀 크기 */
  width: number;
  height: number;
  /** 축소 전 원본 이미지 실제 픽셀 크기 */
  originalWidth: number;
  originalHeight: number;
  /** 적용된 축소 비율 (1 이면 축소 없음) */
  scale: number;
}

/** data URL 에서 MIME 과 base64 페이로드를 분리 (형식이 아니면 undefined) */
function splitDataUrl(dataUrl: string): { mimeType: string; payload: string } | undefined {
  const match = /^data:([^;,]+);base64,/.exec(dataUrl);
  if (!match) return undefined;
  return { mimeType: match[1], payload: dataUrl.slice(match[0].length) };
}

/**
 * scalemaker fork: 이미지를 "모델에게 보내기 좋은" 크기/포맷으로 정규화한다.
 *
 * - 긴 변이 maxLongEdge 를 넘으면 비율을 유지한 채 축소한다(실제 비트맵 크기 기준으로 배율 계산).
 * - 축소가 필요 없어도 기본적으로 JPEG(quality) 로 재인코딩한다.
 *   단, 원본(예: 단색이 많은 PNG)이 더 작으면 원본을 그대로 쓴다.
 *
 * @param imageDataUrl 원본 이미지 data URL
 * @param options maxLongEdge(기본 1568), quality(기본 0.8), format(기본 image/jpeg)
 */
export async function prepareImageForModelInput(
  imageDataUrl: string,
  options: {
    maxLongEdge?: number;
    quality?: number;
    format?: 'image/jpeg' | 'image/webp';
  } = {},
): Promise<ModelInputImage> {
  const { maxLongEdge = MODEL_INPUT_MAX_LONG_EDGE, quality = 0.8, format = 'image/jpeg' } = options;

  const bitmap = await createImageBitmapFromUrl(imageDataUrl);
  const originalWidth = bitmap.width;
  const originalHeight = bitmap.height;
  bitmap.close();

  const longEdge = Math.max(originalWidth, originalHeight);
  const scale = longEdge > maxLongEdge && longEdge > 0 ? maxLongEdge / longEdge : 1;

  const compressed = await compressImage(imageDataUrl, { scale, quality, format });
  // compressImage 와 동일한 반올림 규칙을 써야 실제 픽셀 크기와 메타데이터가 어긋나지 않는다
  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));

  if (scale === 1) {
    const original = splitDataUrl(imageDataUrl);
    const encoded = splitDataUrl(compressed.dataUrl);
    // 축소가 없었고 원본이 더 작으면(주로 PNG) 굳이 JPEG 로 바꾸지 않는다
    if (original && encoded && original.payload.length < encoded.payload.length) {
      return {
        dataUrl: imageDataUrl,
        mimeType: original.mimeType,
        width: originalWidth,
        height: originalHeight,
        originalWidth,
        originalHeight,
        scale: 1,
      };
    }
  }

  return {
    dataUrl: compressed.dataUrl,
    mimeType: compressed.mimeType,
    width,
    height,
    originalWidth,
    originalHeight,
    scale,
  };
}
