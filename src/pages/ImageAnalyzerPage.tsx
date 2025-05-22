import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { showSuccess, showError } from '@/utils/toast';
import { X as XIcon, Maximize as MaximizeIcon } from 'lucide-react';

// --- Interfaces (remain the same) ---
interface AnalysisResult {
  rect: { x: number; y: number; width: number; height: number };
  textColor: string;
  fontSize: number;
  avgBackgroundColor: { r: number; g: number; b: number };
  aspectRatioName?: string;
  actualCells: { rows: number; cols: number };
  rectBusyness: number;
  textContrastRatio: number;
}

interface CellStat {
  avgColor: { r: number; g: number; b: number };
  busyness: number;
}

interface AnalysisDataForHover {
  stats: CellStat[];
  gridConfig: { rows: number; cols: number };
  cellWidthPx: number;
  cellHeightPx: number;
  canvasWidth: number;
  canvasHeight: number;
}

interface ShapeToFind {
  name: string;
  rows: number;
  cols: number;
}

interface FoundRectInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  avgColor: { r: number; g: number; b: number };
  rStart: number;
  cStart: number;
  avgBusyness: number;
  shape: ShapeToFind;
}

interface ImageAnalysisCoreParams {
  imageData: ImageData;
  gridConfig: { rows: number; cols: number };
  targetAreaValue: number;
  useAverageCellColorForText: boolean;
  borderExclusionCells: number;
}

interface ImageAnalysisCoreResult {
  analysisResultData: AnalysisResult | null;
  analysisDataForHover: AnalysisDataForHover | null;
}

// --- Debounce Helper ---
function debounce<F extends (...args: any[]) => any>(func: F, waitFor: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<F>): void => {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => func(...args), waitFor);
  };
}

// --- Image Analysis Core Logic (remains the same) ---
const getLuminance = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;
const calculateContrastRatio = (color1: { r: number; g: number; b: number }, color2: { r: number; g: number; b: number }): number => {
  const lum1 = getLuminance(color1.r, color1.g, color1.b);
  const lum2 = getLuminance(color2.r, color2.g, color2.b);
  const lighterLum = Math.max(lum1, lum2);
  const darkerLum = Math.min(lum1, lum2);
  return (lighterLum + 0.05 * 255) / (darkerLum + 0.05 * 255);
};
const generateShapesToTest = (targetArea: number, maxRows: number, maxCols: number): ShapeToFind[] => {
  const shapes = new Map<string, ShapeToFind>();
  const addShape = (namePrefix: string, r: number, c: number) => {
    if (r <= 0 || c <= 0 || r > maxRows || c > maxCols || r * c < targetArea * 0.8) return;
    const key = `${r}x${c}`;
    if (!shapes.has(key)) {
      let name = namePrefix;
      if (Math.abs(r - c) <= Math.max(1, Math.min(r, c) * 0.25)) name = "square";
      else if (c > r * 1.25) name = "landscape";
      else if (r > c * 1.25) name = "portrait";
      else name = "near-square";
      shapes.set(key, { name, rows: r, cols: c });
    }
  };
  let r_s = Math.max(1, Math.round(Math.sqrt(targetArea)));
  let c_s = Math.max(1, Math.ceil(targetArea / r_s));
  addShape("square_attempt1", r_s, c_s); addShape("square_attempt2", c_s, r_s);
  let r_ls = Math.max(1, Math.round(Math.sqrt(targetArea / 1.8)));
  let c_ls = Math.max(1, Math.ceil(targetArea / r_ls));
  if (r_ls * c_ls < targetArea && c_ls < maxCols) c_ls++;
  addShape("landscape_attempt", r_ls, c_ls);
  let c_pt = Math.max(1, Math.round(Math.sqrt(targetArea / 1.8)));
  let r_pt = Math.max(1, Math.ceil(targetArea / c_pt));
  if (r_pt * c_pt < targetArea && r_pt < maxRows) r_pt++;
  addShape("portrait_attempt", r_pt, c_pt);
  if (targetArea <= maxCols) addShape("extreme_ls", 1, Math.min(maxCols, Math.max(targetArea, Math.ceil(targetArea/1))));
  if (targetArea <= maxRows) addShape("extreme_pt", Math.min(maxRows, Math.max(targetArea, Math.ceil(targetArea/1))), 1);
  addShape("square_large1", r_s + 1, c_s); addShape("square_large2", r_s, c_s + 1);
  return Array.from(shapes.values());
};
const findBestRectForGivenShape = (
  shapeToFind: ShapeToFind, cellStats: CellStat[], currentGridConfig: { rows: number; cols: number },
  cellWidthPx: number, cellHeightPx: number, borderExclusion: number
): FoundRectInfo | null => {
  let bestRect: FoundRectInfo | null = null; let minAvgBusyness = Infinity;
  if (shapeToFind.rows + 2 * borderExclusion > currentGridConfig.rows || shapeToFind.cols + 2 * borderExclusion > currentGridConfig.cols) return null;
  const maxRStart = currentGridConfig.rows - shapeToFind.rows - borderExclusion;
  const maxCStart = currentGridConfig.cols - shapeToFind.cols - borderExclusion;
  for (let rStart = borderExclusion; rStart <= maxRStart; rStart++) {
    for (let cStart = borderExclusion; cStart <= maxCStart; cStart++) {
      let currentRectBusynessSum = 0; let pixelCount = 0;
      let rectSumR = 0, rectSumG = 0, rectSumB = 0;
      for (let rOffset = 0; rOffset < shapeToFind.rows; rOffset++) {
        for (let cOffset = 0; cOffset < shapeToFind.cols; cOffset++) {
          const cellIndex = (rStart + rOffset) * currentGridConfig.cols + (cStart + cOffset);
          currentRectBusynessSum += cellStats[cellIndex].busyness;
          rectSumR += cellStats[cellIndex].avgColor.r; rectSumG += cellStats[cellIndex].avgColor.g; rectSumB += cellStats[cellIndex].avgColor.b;
          pixelCount++;
        }
      }
      if (pixelCount === 0) continue;
      const avgBusynessForRect = currentRectBusynessSum / pixelCount;
      if (avgBusynessForRect < minAvgBusyness) {
        minAvgBusyness = avgBusynessForRect;
        bestRect = {
          x: Math.floor(cStart * cellWidthPx), y: Math.floor(rStart * cellHeightPx),
          width: Math.floor(shapeToFind.cols * cellWidthPx), height: Math.floor(shapeToFind.rows * cellHeightPx),
          avgColor: { r: rectSumR / pixelCount, g: rectSumG / pixelCount, b: rectSumB / pixelCount },
          rStart, cStart, avgBusyness: avgBusynessForRect, shape: shapeToFind,
        };
      }
    }
  }
  return bestRect;
};
const analyzeImageCore = (params: ImageAnalysisCoreParams): ImageAnalysisCoreResult => {
  const { imageData, gridConfig, targetAreaValue, useAverageCellColorForText, borderExclusionCells } = params;
  const { data, width: imgWidth, height: imgHeight } = imageData;
  if (imgWidth === 0 || imgHeight === 0) {
    // showError("Image data for analysis has zero dimensions."); // This might be too noisy
    return { analysisResultData: null, analysisDataForHover: null };
  }
  const cellWidthPx = imgWidth / gridConfig.cols; const cellHeightPx = imgHeight / gridConfig.rows;
  const currentCellStats: CellStat[] = [];
  for (let r = 0; r < gridConfig.rows; r++) {
    for (let c = 0; c < gridConfig.cols; c++) {
      const cellX = Math.floor(c * cellWidthPx); const cellY = Math.floor(r * cellHeightPx);
      const cCellWidth = Math.floor((c + 1) * cellWidthPx) - cellX; const cCellHeight = Math.floor((r + 1) * cellHeightPx) - cellY;
      let sumR = 0, sumG = 0, sumB = 0; const luminances: number[] = []; let pCount = 0;
      for (let y = cellY; y < cellY + cCellHeight; y++) {
        for (let x = cellX; x < cellX + cCellWidth; x++) {
          const i = (y * imgWidth + x) * 4;
          sumR += data[i]; sumG += data[i + 1]; sumB += data[i + 2];
          luminances.push(getLuminance(data[i], data[i + 1], data[i + 2])); pCount++;
        }
      }
      if (pCount === 0) { currentCellStats.push({ avgColor: { r: 0, g: 0, b: 0 }, busyness: Infinity }); continue; }
      const avgR = sumR / pCount; const avgG = sumG / pCount; const avgB = sumB / pCount;
      const avgL = luminances.reduce((acc, l) => acc + l, 0) / pCount;
      const busyness = luminances.reduce((acc, l) => acc + Math.pow(l - avgL, 2), 0) / pCount;
      currentCellStats.push({ avgColor: { r: avgR, g: avgG, b: avgB }, busyness });
    }
  }
  const analysisDataForHover: AnalysisDataForHover = {
    stats: currentCellStats, gridConfig: { ...gridConfig }, cellWidthPx, cellHeightPx,
    canvasWidth: imgWidth, canvasHeight: imgHeight,
  };
  const effectiveMaxRows = gridConfig.rows - 2 * borderExclusionCells;
  const effectiveMaxCols = gridConfig.cols - 2 * borderExclusionCells;
  const shapesToTest = generateShapesToTest(targetAreaValue, effectiveMaxRows, effectiveMaxCols);
  if (shapesToTest.length === 0) {
    showError("Could not generate valid shapes. Try reducing border exclusion or increasing grid/target area.");
    return { analysisResultData: null, analysisDataForHover };
  }
  let overallBestRect: FoundRectInfo | null = null;
  for (const shape of shapesToTest) {
    const rectInfoForShape = findBestRectForGivenShape(shape, currentCellStats, gridConfig, cellWidthPx, cellHeightPx, borderExclusionCells);
    if (rectInfoForShape) {
      if (!overallBestRect || rectInfoForShape.avgBusyness < overallBestRect.avgBusyness) {
        overallBestRect = rectInfoForShape;
      }
    }
  }
  if (!overallBestRect) {
    // showError("Could not find a suitable area with current settings. Try different parameters."); // Can be noisy
    return { analysisResultData: null, analysisDataForHover };
  }
  let chosenTextColor: string; const rectBgColor = overallBestRect.avgColor;
  if (useAverageCellColorForText) {
    let bestContrastCellColor: { r: number; g: number; b: number } | null = null; let maxContrast = 0;
    for (let rOffset = 0; rOffset < overallBestRect.shape.rows; rOffset++) {
      for (let cOffset = 0; cOffset < overallBestRect.shape.cols; cOffset++) {
        const cellIndex = (overallBestRect.rStart + rOffset) * gridConfig.cols + (overallBestRect.cStart + cOffset);
        const cellAvgColor = currentCellStats[cellIndex].avgColor;
        const contrast = calculateContrastRatio(cellAvgColor, rectBgColor);
        if (contrast > maxContrast) { maxContrast = contrast; bestContrastCellColor = cellAvgColor; }
      }
    }
    if (bestContrastCellColor && maxContrast > 2.5) {
      chosenTextColor = `rgb(${Math.round(bestContrastCellColor.r)}, ${Math.round(bestContrastCellColor.g)}, ${Math.round(bestContrastCellColor.b)})`;
    } else {
      chosenTextColor = getLuminance(rectBgColor.r, rectBgColor.g, rectBgColor.b) > 128 ? 'black' : 'white';
    }
  } else {
    chosenTextColor = getLuminance(rectBgColor.r, rectBgColor.g, rectBgColor.b) > 128 ? 'black' : 'white';
  }
  let textColorObject: { r: number; g: number; b: number };
  if (chosenTextColor === 'black') textColorObject = { r: 0, g: 0, b: 0 };
  else if (chosenTextColor === 'white') textColorObject = { r: 255, g: 255, b: 255 };
  else {
    const match = chosenTextColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    textColorObject = match ? { r: parseInt(match[1]), g: parseInt(match[2]), b: parseInt(match[3]) } : { r: 0, g: 0, b: 0 };
  }
  const textContrastRatio = calculateContrastRatio(textColorObject, rectBgColor);
  const singleCellHeightInRect = overallBestRect.height / overallBestRect.shape.rows;
  const fontSize = Math.max(12, Math.min(singleCellHeightInRect * 0.6, overallBestRect.height * 0.3, overallBestRect.width * 0.2));
  const analysisResultData: AnalysisResult = {
    rect: { x: overallBestRect.x, y: overallBestRect.y, width: overallBestRect.width, height: overallBestRect.height },
    textColor: chosenTextColor, fontSize, avgBackgroundColor: rectBgColor,
    aspectRatioName: overallBestRect.shape.name,
    actualCells: { rows: overallBestRect.shape.rows, cols: overallBestRect.shape.cols },
    rectBusyness: overallBestRect.avgBusyness, textContrastRatio,
  };
  // showSuccess(`Analysis complete! Best area: ${overallBestRect.shape.name}.`); // Only show for main analysis
  return { analysisResultData, analysisDataForHover };
};

// --- Text Rendering Helper ---
const TEXT_PADDING = 10;
const LINE_HEIGHT_MULTIPLIER = 1.2;
const MIN_RENDER_FONT_SIZE = 8;
const CONTRAST_THRESHOLD_FOR_SCRIM = 4.0;
const BUSYNESS_THRESHOLD_FOR_SCRIM = 500;

function wrapTextCanvas(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (!text.trim() || maxWidth <=0) return [];
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = words[0];
  if (words.length === 0) return [];
  if (ctx.measureText(currentLine).width > maxWidth) return [currentLine];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const testLine = currentLine + (currentLine ? " " : "") + word;
    if (ctx.measureText(testLine).width < maxWidth) currentLine = testLine;
    else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
      if (ctx.measureText(currentLine).width > maxWidth) {
        if (lines.length === 0) { lines.push(currentLine); currentLine = ""; break; }
      }
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

function renderTextWithDynamicSizing(
  ctx: CanvasRenderingContext2D,
  textToRender: string,
  currentAnalysisResult: AnalysisResult,
  targetCanvasWidth: number,
  targetCanvasHeight: number
) {
  const { rect, textColor, avgBackgroundColor, fontSize: initialFontSize, textContrastRatio, rectBusyness } = currentAnalysisResult;
  const needsScrim = textContrastRatio < CONTRAST_THRESHOLD_FOR_SCRIM || rectBusyness > BUSYNESS_THRESHOLD_FOR_SCRIM;

  if (needsScrim) {
    const textIsDark = textColor === 'black' || getLuminance(parseInt(textColor.substring(4,7) || "0"), parseInt(textColor.substring(9,12) || "0"), parseInt(textColor.substring(14,17) || "0")) < 128;
    const scrimBaseColor = textIsDark ? '255,255,255' : '0,0,0';
    let scrimOpacity = 0.5;
    if (textContrastRatio < 2.5) scrimOpacity = 0.7; else if (textContrastRatio < 3.5) scrimOpacity = 0.6;
    ctx.fillStyle = `rgba(${scrimBaseColor}, ${scrimOpacity})`;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  }

  ctx.fillStyle = textColor;
  let renderFontSize = Math.min(initialFontSize, rect.height - 2 * TEXT_PADDING, (rect.width - 2 * TEXT_PADDING) / 2);
  renderFontSize = Math.max(renderFontSize, MIN_RENDER_FONT_SIZE);
  let wrappedLines: string[] = [];
  let textBlockHeight = 0;
  const availableRectWidth = rect.width - 2 * TEXT_PADDING;
  const availableRectHeight = rect.height - 2 * TEXT_PADDING;

  if (availableRectWidth > 0 && availableRectHeight > 0) {
    for (let currentSize = renderFontSize; currentSize >= MIN_RENDER_FONT_SIZE; currentSize--) {
      ctx.font = `${currentSize}px Arial`;
      const lines = wrapTextCanvas(ctx, textToRender, availableRectWidth);
      const currentBlockHeight = lines.length * (currentSize * LINE_HEIGHT_MULTIPLIER);
      let linesFitWidth = true;
      for(const line of lines) { if (ctx.measureText(line).width > availableRectWidth) { linesFitWidth = false; break; } }
      if (currentBlockHeight <= availableRectHeight && linesFitWidth) {
        renderFontSize = currentSize; wrappedLines = lines; textBlockHeight = currentBlockHeight; break; 
      }
    }
  }

  if (wrappedLines.length > 0) {
    const rectCenterX = rect.x + rect.width / 2;
    const rectCenterY = rect.y + rect.height / 2;
    let hAlign: CanvasTextAlign = 'center';
    let vAlign: 'top' | 'middle' | 'bottom' = 'middle';
    if (rectCenterX < targetCanvasWidth * 0.35) hAlign = 'left';
    else if (rectCenterX > targetCanvasWidth * 0.65) hAlign = 'right';
    if (rectCenterY < targetCanvasHeight * 0.35) vAlign = 'top';
    else if (rectCenterY > targetCanvasHeight * 0.65) vAlign = 'bottom';
    ctx.textAlign = hAlign;
    ctx.textBaseline = 'top';
    let textDrawX: number;
    if (hAlign === 'left') textDrawX = rect.x + TEXT_PADDING;
    else if (hAlign === 'right') textDrawX = rect.x + rect.width - TEXT_PADDING;
    else textDrawX = rect.x + rect.width / 2;
    let blockStartY: number;
    if (vAlign === 'top') blockStartY = rect.y + TEXT_PADDING;
    else if (vAlign === 'bottom') blockStartY = rect.y + rect.height - TEXT_PADDING - textBlockHeight;
    else blockStartY = rect.y + TEXT_PADDING + (availableRectHeight - textBlockHeight) / 2;
    const lineHeight = renderFontSize * LINE_HEIGHT_MULTIPLIER;
    for (let i = 0; i < wrappedLines.length; i++) {
      ctx.fillText(wrappedLines[i], textDrawX, blockStartY + (i * lineHeight));
    }
  }
}


const ImageAnalyzerPage: React.FC = () => {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [originalImage, setOriginalImage] = useState<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fullscreenCanvasRef = useRef<HTMLCanvasElement>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [analysisDataForHover, setAnalysisDataForHover] = useState<AnalysisDataForHover | null>(null);
  const [hoveredCell, setHoveredCell] = useState<{ r: number; c: number } | null>(null);
  const [isMouseOverCanvas, setIsMouseOverCanvas] = useState(false);
  const [gridConfig, setGridConfig] = useState({ rows: 10, cols: 10 });
  const [neededAreaValue, setNeededAreaValue] = useState(12);
  const [useAverageCellColor, setUseAverageCellColor] = useState(false);
  const [borderExclusionCells, setBorderExclusionCells] = useState(0);
  const [userText, setUserText] = useState("Your Awesome Text Here");
  const [isLoading, setIsLoading] = useState(false);
  const MAX_CANVAS_WIDTH = 800; const MAX_CANVAS_HEIGHT = 600;

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenAnalysisResult, setFullscreenAnalysisResult] = useState<AnalysisResult | null>(null);
  const [viewportDimensions, setViewportDimensions] = useState({ width: window.innerWidth, height: window.innerHeight });
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);


  // Handle window resize for fullscreen
  useEffect(() => {
    const handleResize = debounce(() => {
      setViewportDimensions({ width: window.innerWidth, height: window.innerHeight });
    }, 250);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Analyze for fullscreen when relevant states change
  useEffect(() => {
    if (isFullscreen && originalImage && viewportDimensions.width > 0 && viewportDimensions.height > 0) {
      if (!offscreenCanvasRef.current) {
        offscreenCanvasRef.current = document.createElement('canvas');
      }
      const tempCanvas = offscreenCanvasRef.current;
      const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
      if (!tempCtx) return;

      tempCanvas.width = viewportDimensions.width;
      tempCanvas.height = viewportDimensions.height;

      const imgW = originalImage.naturalWidth;
      const imgH = originalImage.naturalHeight;
      const vpW = viewportDimensions.width;
      const vpH = viewportDimensions.height;

      const imgAspect = imgW / imgH;
      const vpAspect = vpW / vpH;

      let sx = 0, sy = 0, sWidth = imgW, sHeight = imgH;

      if (imgAspect > vpAspect) { // Image is wider than viewport (letterboxed top/bottom, or cropped sides for cover)
        sHeight = imgH;
        sWidth = imgH * vpAspect;
        sx = (imgW - sWidth) / 2;
      } else { // Image is taller than viewport (letterboxed sides, or cropped top/bottom for cover)
        sWidth = imgW;
        sHeight = imgW / vpAspect;
        sy = (imgH - sHeight) / 2;
      }
      
      tempCtx.drawImage(originalImage, sx, sy, sWidth, sHeight, 0, 0, vpW, vpH);
      const imageData = tempCtx.getImageData(0, 0, vpW, vpH);
      
      const coreResult = analyzeImageCore({
        imageData, gridConfig, targetAreaValue: neededAreaValue,
        useAverageCellColorForText: useAverageCellColor,
        borderExclusionCells: borderExclusionCells, // Use main UI border exclusion for now
      });
      setFullscreenAnalysisResult(coreResult.analysisResultData);
    } else {
      setFullscreenAnalysisResult(null);
    }
  }, [isFullscreen, originalImage, viewportDimensions, gridConfig, neededAreaValue, useAverageCellColor, borderExclusionCells]);


  // Main canvas drawing (normal mode)
  useEffect(() => {
    if (isFullscreen || !canvasRef.current) return;
    const canvas = canvasRef.current; const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let displayWidth = MAX_CANVAS_WIDTH; let displayHeight = MAX_CANVAS_HEIGHT;
    if (originalImage) {
        displayWidth = originalImage.width; displayHeight = originalImage.height;
        if (displayWidth > MAX_CANVAS_WIDTH) { const r = MAX_CANVAS_WIDTH / displayWidth; displayWidth = MAX_CANVAS_WIDTH; displayHeight *= r; }
        if (displayHeight > MAX_CANVAS_HEIGHT) { const r = MAX_CANVAS_HEIGHT / displayHeight; displayHeight = MAX_CANVAS_HEIGHT; displayWidth *= r; }
    } else {
        displayWidth = Math.min(window.innerWidth * 0.8, MAX_CANVAS_WIDTH); displayHeight = displayWidth * (MAX_CANVAS_HEIGHT / MAX_CANVAS_WIDTH);
    }
    canvas.width = displayWidth; canvas.height = displayHeight; ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (originalImage) ctx.drawImage(originalImage, 0, 0, canvas.width, canvas.height);
    else {
      ctx.fillStyle = "#f0f0f0"; ctx.fillRect(0,0, canvas.width, canvas.height);
      ctx.fillStyle = "#a0a0a0"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = "16px Arial"; ctx.fillText("Upload an image to begin", canvas.width / 2, canvas.height / 2);
    }

    if (isMouseOverCanvas && analysisDataForHover) {
      const { stats, gridConfig: hoverGridConfig, cellWidthPx, cellHeightPx } = analysisDataForHover;
      const busynessFontSize = Math.max(8, Math.min(cellWidthPx * 0.15, cellHeightPx * 0.15));
      ctx.font = `${busynessFontSize}px Arial`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      for (let r_idx = 0; r_idx < hoverGridConfig.rows; r_idx++) {
        for (let c_idx = 0; c_idx < hoverGridConfig.cols; c_idx++) {
          const cellIndex = r_idx * hoverGridConfig.cols + c_idx; if (cellIndex >= stats.length) continue;
          const stat = stats[cellIndex]; const x = c_idx * cellWidthPx; const y = r_idx * cellHeightPx;
          ctx.strokeStyle = 'rgba(200, 200, 200, 0.5)'; ctx.lineWidth = 1; ctx.strokeRect(x, y, cellWidthPx, cellHeightPx);
          const swatchSize = Math.min(cellWidthPx, cellHeightPx) * 0.2;
          ctx.fillStyle = `rgb(${Math.round(stat.avgColor.r)}, ${Math.round(stat.avgColor.g)}, ${Math.round(stat.avgColor.b)})`;
          ctx.fillRect(x + 2, y + 2, swatchSize, swatchSize);
          ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.strokeRect(x + 2, y + 2, swatchSize, swatchSize);
          ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'; ctx.fillText(stat.busyness.toFixed(0), x + swatchSize + 4, y + 2);
          if (hoveredCell && hoveredCell.r === r_idx && hoveredCell.c === c_idx) {
            ctx.strokeStyle = 'rgba(0, 255, 0, 0.9)'; ctx.lineWidth = 2; ctx.strokeRect(x, y, cellWidthPx, cellHeightPx);
          }
        }
      }
      if (analysisResult) {
        const borderColor = analysisResult.textColor === 'black' || analysisResult.textColor.startsWith('rgb(0,0,0)') ? 'rgba(0, 255, 0, 0.8)' : 'rgba(0, 0, 255, 0.8)';
        ctx.strokeStyle = borderColor; ctx.lineWidth = 3;
        ctx.strokeRect(analysisResult.rect.x, analysisResult.rect.y, analysisResult.rect.width, analysisResult.rect.height);
      }
    } else if (analysisResult && userText) {
      renderTextWithDynamicSizing(ctx, userText, analysisResult, canvas.width, canvas.height);
    }
  }, [imageSrc, originalImage, analysisResult, analysisDataForHover, isMouseOverCanvas, hoveredCell, userText, gridConfig, neededAreaValue, useAverageCellColor, borderExclusionCells, isFullscreen]);

  // Fullscreen canvas drawing
  useEffect(() => {
    if (!isFullscreen || !fullscreenCanvasRef.current || !fullscreenAnalysisResult || !userText) {
      if (fullscreenCanvasRef.current) { // Clear if exiting or no result
        const fsCanvas = fullscreenCanvasRef.current;
        const fsCtx = fsCanvas.getContext('2d');
        if (fsCtx) {
            fsCanvas.width = viewportDimensions.width; // Ensure it's sized
            fsCanvas.height = viewportDimensions.height;
            fsCtx.clearRect(0, 0, fsCanvas.width, fsCanvas.height);
        }
      }
      return;
    }
    const fsCanvas = fullscreenCanvasRef.current;
    const fsCtx = fsCanvas.getContext('2d');
    if (!fsCtx) return;

    fsCanvas.width = viewportDimensions.width;
    fsCanvas.height = viewportDimensions.height;
    fsCtx.clearRect(0, 0, fsCanvas.width, fsCanvas.height);

    renderTextWithDynamicSizing(fsCtx, userText, fullscreenAnalysisResult, fsCanvas.width, fsCanvas.height);

  }, [isFullscreen, fullscreenAnalysisResult, userText, viewportDimensions]);


  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const imgSrc = e.target?.result as string; setImageSrc(imgSrc);
        const img = new Image();
        img.onload = () => { setOriginalImage(img); setAnalysisResult(null); setAnalysisDataForHover(null); setFullscreenAnalysisResult(null); };
        img.src = imgSrc;
      };
      reader.readAsDataURL(file);
    }
  };
  
  const triggerAnalysis = () => {
    if (!originalImage || !canvasRef.current) { showError("Please upload an image first."); return; }
    setIsLoading(true); setAnalysisResult(null); setAnalysisDataForHover(null);
    setTimeout(() => {
      try {
        const canvas = canvasRef.current!; const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) { showError("Could not get canvas context."); setIsLoading(false); return; }
        let drawWidth = originalImage.width; let drawHeight = originalImage.height;
        if (drawWidth > MAX_CANVAS_WIDTH) { const r = MAX_CANVAS_WIDTH / drawWidth; drawWidth = MAX_CANVAS_WIDTH; drawHeight *= r; }
        if (drawHeight > MAX_CANVAS_HEIGHT) { const r = MAX_CANVAS_HEIGHT / drawHeight; drawHeight = MAX_CANVAS_HEIGHT; drawWidth *= r; }
        canvas.width = drawWidth; canvas.height = drawHeight;
        ctx.drawImage(originalImage, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const coreResult = analyzeImageCore({
          imageData, gridConfig, targetAreaValue: neededAreaValue, 
          useAverageCellColorForText: useAverageCellColor,
          borderExclusionCells: borderExclusionCells,
        });
        setAnalysisResult(coreResult.analysisResultData); 
        setAnalysisDataForHover(coreResult.analysisDataForHover); // Keep this for hover on main canvas
        if (coreResult.analysisResultData) {
            showSuccess(`Analysis complete! Best area: ${coreResult.analysisResultData.aspectRatioName}.`);
        } else {
            showError("Main analysis could not find a suitable area.");
        }
      } catch (e: any) { console.error("Analysis error:", e); showError(`Analysis failed: ${e.message}`);
      } finally { setIsLoading(false); }
    }, 50);
  };

  const handleCanvasMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (isFullscreen || !analysisDataForHover) return; // No hover effect in fullscreen
    const canvas = event.currentTarget; const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left; const y = event.clientY - rect.top;
    const { cellWidthPx, cellHeightPx, gridConfig: hoverGridConfig, canvasWidth, canvasHeight } = analysisDataForHover;
    const scaledX = x * (canvasWidth / canvas.width); const scaledY = y * (canvasHeight / canvas.height);
    const c = Math.floor(scaledX / cellWidthPx); const r_coord = Math.floor(scaledY / cellHeightPx);
    if (r_coord >= 0 && r_coord < hoverGridConfig.rows && c >= 0 && c < hoverGridConfig.cols) { setHoveredCell({ r: r_coord, c }); } 
    else { setHoveredCell(null); }
  };

  return (
    <div className="container mx-auto p-4 space-y-8">
      {!isFullscreen && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Image Text Placement Analyzer</CardTitle>
              <CardDescription>Upload an image, define text, configure grid & target area, and analyze.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="image-upload">Upload Image</Label>
                <Input id="image-upload" type="file" accept="image/*" onChange={handleImageUpload} className="cursor-pointer" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="user-text">Text to Place</Label>
                <Input id="user-text" type="text" value={userText} onChange={(e) => setUserText(e.target.value)} placeholder="Your Text Here" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="grid-rows">Grid Rows</Label>
                  <Input id="grid-rows" type="number" value={gridConfig.rows} onChange={(e) => setGridConfig(prev => ({ ...prev, rows: Math.max(1, parseInt(e.target.value) || 1) }))} min="1" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="grid-cols">Grid Columns</Label>
                  <Input id="grid-cols" type="number" value={gridConfig.cols} onChange={(e) => setGridConfig(prev => ({ ...prev, cols: Math.max(1, parseInt(e.target.value) || 1) }))} min="1" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="needed-area">Target Area (cells)</Label>
                  <Input id="needed-area" type="number" value={neededAreaValue} onChange={(e) => setNeededAreaValue(Math.max(1, parseInt(e.target.value) || 1))} min="1" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="border-exclusion">Exclude Border Cells</Label>
                  <Input id="border-exclusion" type="number" value={borderExclusionCells} onChange={(e) => setBorderExclusionCells(Math.max(0, parseInt(e.target.value) || 0))} min="0" />
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox id="use-average-cell-color" checked={useAverageCellColor} onCheckedChange={(checked) => setUseAverageCellColor(checked as boolean)} />
                <Label htmlFor="use-average-cell-color" className="cursor-pointer">Use Cell's Average Color for Text (if contrast is sufficient)</Label>
              </div>
              <div className="flex space-x-2">
                <Button onClick={triggerAnalysis} disabled={!imageSrc || isLoading} className="flex-grow">
                  {isLoading ? "Analyzing..." : "Analyze Image"}
                </Button>
                {imageSrc && (
                  <Button onClick={() => setIsFullscreen(true)} variant="outline" title="Go Fullscreen">
                    <MaximizeIcon className="h-5 w-5" />
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {imageSrc && (
            <Card>
              <CardHeader><CardTitle>Image Preview & Analysis</CardTitle></CardHeader>
              <CardContent className="flex justify-center items-center">
                <canvas ref={canvasRef} className="border border-gray-300 max-w-full cursor-crosshair" 
                  style={{maxWidth: `${MAX_CANVAS_WIDTH}px`, maxHeight: `${MAX_CANVAS_HEIGHT}px`}}
                  onMouseMove={handleCanvasMouseMove} onMouseEnter={() => setIsMouseOverCanvas(true)}
                  onMouseLeave={() => { setIsMouseOverCanvas(false); setHoveredCell(null); }}
                />
              </CardContent>
            </Card>
          )}

          {analysisResult && (
            <Card>
              <CardHeader><CardTitle>Analysis Result (Normal Mode)</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <p>Best aspect ratio found: <span className="font-semibold">{analysisResult.aspectRatioName || 'N/A'}</span> (using {analysisResult.actualCells.rows}x{analysisResult.actualCells.cols} cells)</p>
                <p>Recommended text color: 
                  <span style={{ color: analysisResult.textColor, 
                    backgroundColor: `rgb(${Math.round(analysisResult.avgBackgroundColor.r)}, ${Math.round(analysisResult.avgBackgroundColor.g)}, ${Math.round(analysisResult.avgBackgroundColor.b)})`, 
                    padding: '2px 6px', marginLeft: '8px', border: '1px solid #ccc', borderRadius: '4px', display: 'inline-block'
                  }}>PREVIEW</span> 
                  <span className="ml-2 text-sm text-gray-600">({analysisResult.textColor})</span>
                </p>
                <p>Rectangle Busyness: <span className="font-semibold">{analysisResult.rectBusyness.toFixed(2)}</span></p>
                <p>Text Contrast Ratio: <span className="font-semibold">{analysisResult.textContrastRatio.toFixed(2)}:1</span></p>
                <p>Suggested initial font size: {analysisResult.fontSize.toFixed(0)}px (actual render size may vary)</p>
                <p>Suggested area (X, Y, Width, Height): {analysisResult.rect.x.toFixed(0)}, {analysisResult.rect.y.toFixed(0)}, {analysisResult.rect.width.toFixed(0)}, {analysisResult.rect.height.toFixed(0)}</p>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {isFullscreen && originalImage && (
        <div className="fixed inset-0 z-50 bg-black">
          <img 
            src={originalImage.src} 
            alt="Fullscreen Preview" 
            className="absolute inset-0 w-full h-full object-cover"
          />
          <canvas 
            ref={fullscreenCanvasRef} 
            className="absolute inset-0 w-full h-full"
            width={viewportDimensions.width}
            height={viewportDimensions.height}
          />
          <Button 
            onClick={() => setIsFullscreen(false)} 
            variant="ghost" 
            size="icon"
            className="absolute top-4 right-4 text-white bg-black/50 hover:bg-black/75 hover:text-white"
            title="Close Fullscreen"
          >
            <XIcon className="h-6 w-6" />
          </Button>
          {fullscreenAnalysisResult && (
             <div className="absolute bottom-4 left-4 bg-black/70 text-white p-2 rounded text-xs">
                <p>Fullscreen Analysis:</p>
                <p>Rect: {fullscreenAnalysisResult.rect.x.toFixed(0)},{fullscreenAnalysisResult.rect.y.toFixed(0)} {fullscreenAnalysisResult.rect.width.toFixed(0)}x{fullscreenAnalysisResult.rect.height.toFixed(0)}</p>
                <p>Busyness: {fullscreenAnalysisResult.rectBusyness.toFixed(1)}, Contrast: {fullscreenAnalysisResult.textContrastRatio.toFixed(1)}:1</p>
             </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ImageAnalyzerPage;