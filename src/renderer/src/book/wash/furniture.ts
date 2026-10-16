/**
 * 新手流程“点家具，她给它上色”的家具形状（体验设计 §7.1“家具就是设置”）。
 * 坐标是近景整景图的纹理坐标（0–1，y 向下）；所有姿势同一机位，形状按写字那张（desk-writing_calm）描。
 * 默认值由助手按图估出，描图工具（?trace 的“家具形状”）里可以逐点修改，保存到 paths/furniture.json 后取代这里。
 */
export interface Furniture { id: string; name: string; points: readonly (readonly [number, number])[] }

export const DEFAULT_FURNITURE: readonly Furniture[] = [
  { id: 'window', name: '窗', points: [[0.104, 0], [0.845, 0], [0.845, 0.5], [0.104, 0.5]] },
  { id: 'curtain', name: '窗帘', points: [[0, 0], [0.104, 0], [0.104, 0.51], [0.06, 0.52], [0, 0.42]] },
  { id: 'curtain-right', name: '右边的窗帘', points: [[0.845, 0], [1, 0], [1, 0.53], [0.845, 0.52]] },
  { id: 'lamp', name: '台灯', points: [[0, 0.263], [0.048, 0.279], [0.068, 0.391], [0.048, 0.415], [0, 0.411]] },
  { id: 'plant', name: '绿植', points: [[0, 0.423], [0.048, 0.415], [0.096, 0.463], [0.088, 0.558], [0.048, 0.614], [0.044, 0.718], [0, 0.718]] },
  { id: 'books', name: '书架', points: [[0.054, 0.528], [0.159, 0.514], [0.187, 0.542], [0.187, 0.694], [0.142, 0.706], [0.102, 0.706], [0.076, 0.703], [0.054, 0.694]] },
  { id: 'mug', name: '杯子', points: [[0.201, 0.638], [0.239, 0.626], [0.275, 0.634], [0.281, 0.678], [0.271, 0.706], [0.239, 0.714], [0.206, 0.706]] },
  { id: 'notebook', name: '本子', points: [[0.171, 0.793], [0.351, 0.75], [0.447, 0.766], [0.542, 0.829], [0.375, 0.887], [0.179, 0.797]] },
  { id: 'note', name: '纸条', points: [[0.048, 0.821], [0.156, 0.805], [0.191, 0.841], [0.068, 0.869]] },
  { id: 'chair', name: '椅子', points: [[0.845, 0.662], [0.949, 0.638], [0.957, 0.662], [0.949, 0.901], [0.917, 0.909], [0.877, 0.797], [0.849, 0.781]] },
  { id: 'desk', name: '书桌', points: [[0, 0.694], [0.399, 0.686], [0.447, 0.702], [0.857, 0.877], [1, 0.941], [1, 1], [0, 1]] },
]

interface FurnitureFile { version: 1; items: Furniture[] }
const edited = import.meta.glob<FurnitureFile>('./paths/furniture.json', { eager: true, import: 'default' })

/** 描图工具保存过就用保存的，否则用默认的 */
export const FURNITURE: readonly Furniture[] = edited['./paths/furniture.json']?.items ?? DEFAULT_FURNITURE
