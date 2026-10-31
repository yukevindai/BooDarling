// Silhouette feature: client-side MediaPipe Image Segmenter + garment-line descriptor.
export { SILHOUETTE_CONFIG, type SilhouetteConfig } from "./config";
export { getImageSegmenter, closeImageSegmenters } from "./segmenter";
export { describeSilhouette, type DescribeOptions } from "./descriptor";
