/** 门牌和去向的叫法：书本左页和迷你窗共用 */
export const MODE_LABEL = { work: '工作中', quiet: '安静', rest: '休息' } as const
export const LOCATION_LABEL: Record<string, string> = { shore: '海岸', swing: '秋千' }
export const locationLabel = (id: string) => LOCATION_LABEL[id] ?? id
