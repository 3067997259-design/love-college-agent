/** A single retrieval judgment used by the memory evaluation harness. */
export interface MemoryEvaluationCase {
  id: string
  query: string
  relevantIds: string[]
  retrievedIds: string[]
  stratum?: string
  queryTokenCount?: number
  normalizedQueryTokenCount?: number
  retrievalLatencyMs?: number
  /** Provider-reported or price-card-derived cost for this retrieval probe. */
  costUsd?: number
}

/** A vector candidate that can be ranked without a storage dependency. */
export interface MemoryEvaluationCandidate {
  id: string
  embedding: number[]
}

export interface MemoryEvaluationMetrics {
  caseCount: number
  recallAtK: number
  meanReciprocalRank: number
  precisionAtK: number
  falsePositiveRateAtK: number
  averageQueryTokenCount: number
  averageAdditionalQueryTokenCount: number
  averageRetrievalLatencyMs: number
  missingQueryTokenCount: number
  missingAdditionalQueryTokenCount: number
  missingRetrievalLatency: number
  /** Average measured cost; undefined when no case supplied a cost. */
  averageCostUsd?: number
  /** Number of cases without a finite cost measurement. */
  missingCostCount?: number
  byStratum: Record<string, {
    caseCount: number
    recallAtK: number
    meanReciprocalRank: number
    precisionAtK: number
    falsePositiveRateAtK: number
  }>
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length)
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < length; index++) {
    const leftValue = Number.isFinite(left[index]) ? left[index] : 0
    const rightValue = Number.isFinite(right[index]) ? right[index] : 0
    dot += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }
  if (leftMagnitude === 0 || rightMagnitude === 0)
    return 0
  return dot / Math.sqrt(leftMagnitude * rightMagnitude)
}

/** Ranks candidates by cosine similarity with stable id tie-breaking. */
export function rankMemoryCandidates(queryEmbedding: number[], candidates: readonly MemoryEvaluationCandidate[], limit = 3): string[] {
  return [...candidates]
    .map(candidate => ({ id: candidate.id, score: cosineSimilarity(queryEmbedding, candidate.embedding) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, limit))
    .map(candidate => candidate.id)
}

/**
 * Computes recall, precision and MRR for a bounded retrieval judgment set.
 * Metrics are also split by stratum so a strong overall mean cannot hide a
 * failed Chinese or cross-category subset.
 */
export function evaluateMemoryRetrieval(cases: readonly MemoryEvaluationCase[], k = 3): MemoryEvaluationMetrics {
  const boundedK = Math.max(1, Math.floor(k))
  const byStratum = new Map<string, MemoryEvaluationCase[]>()
  for (const item of cases) {
    const stratum = item.stratum ?? 'all'
    const bucket = byStratum.get(stratum) ?? []
    bucket.push(item)
    byStratum.set(stratum, bucket)
  }

  function metricsFor(items: readonly MemoryEvaluationCase[]) {
    if (items.length === 0)
      return { caseCount: 0, recallAtK: 0, meanReciprocalRank: 0, precisionAtK: 0, falsePositiveRateAtK: 0, averageQueryTokenCount: 0, averageAdditionalQueryTokenCount: 0, averageRetrievalLatencyMs: 0, missingQueryTokenCount: 0, missingAdditionalQueryTokenCount: 0, missingRetrievalLatency: 0, averageCostUsd: 0, missingCostCount: 0 }
    let recall = 0
    let reciprocalRank = 0
    let precision = 0
    let falsePositiveRate = 0
    let queryTokenCount = 0
    let additionalQueryTokenCount = 0
    let retrievalLatencyMs = 0
    let costUsd = 0
    let measuredQueryTokens = 0
    let measuredAdditionalTokens = 0
    let measuredLatency = 0
    let measuredCost = 0
    for (const item of items) {
      const relevant = new Set(item.relevantIds)
      const retrieved = item.retrievedIds.slice(0, boundedK)
      const hits = retrieved.filter(id => relevant.has(id)).length
      recall += relevant.size === 0 ? 0 : hits / relevant.size
      precision += hits / boundedK
      falsePositiveRate += (retrieved.length - hits) / boundedK
      queryTokenCount += item.queryTokenCount ?? 0
      additionalQueryTokenCount += Math.max(0, (item.normalizedQueryTokenCount ?? item.queryTokenCount ?? 0) - (item.queryTokenCount ?? 0))
      retrievalLatencyMs += item.retrievalLatencyMs ?? 0
      costUsd += item.costUsd ?? 0
      measuredQueryTokens += item.queryTokenCount === undefined ? 0 : 1
      measuredAdditionalTokens += item.queryTokenCount === undefined || item.normalizedQueryTokenCount === undefined ? 0 : 1
      measuredLatency += item.retrievalLatencyMs === undefined ? 0 : 1
      measuredCost += typeof item.costUsd === 'number' && Number.isFinite(item.costUsd) ? 1 : 0
      const firstRelevant = item.retrievedIds.findIndex(id => relevant.has(id))
      if (firstRelevant >= 0 && firstRelevant < boundedK)
        reciprocalRank += 1 / (firstRelevant + 1)
    }
    return {
      caseCount: items.length,
      recallAtK: recall / items.length,
      meanReciprocalRank: reciprocalRank / items.length,
      precisionAtK: precision / items.length,
      falsePositiveRateAtK: falsePositiveRate / items.length,
      averageQueryTokenCount: measuredQueryTokens ? queryTokenCount / measuredQueryTokens : 0,
      averageAdditionalQueryTokenCount: measuredAdditionalTokens ? additionalQueryTokenCount / measuredAdditionalTokens : 0,
      averageRetrievalLatencyMs: measuredLatency ? retrievalLatencyMs / measuredLatency : 0,
      missingQueryTokenCount: items.length - measuredQueryTokens,
      missingAdditionalQueryTokenCount: items.length - measuredAdditionalTokens,
      missingRetrievalLatency: items.length - measuredLatency,
      averageCostUsd: measuredCost ? costUsd / measuredCost : 0,
      missingCostCount: items.length - measuredCost,
    }
  }

  const overall = metricsFor(cases)
  return {
    ...overall,
    byStratum: Object.fromEntries([...byStratum.entries()].map(([stratum, items]) => {
      const metrics = metricsFor(items)
      return [stratum, {
        caseCount: metrics.caseCount,
        recallAtK: metrics.recallAtK,
        meanReciprocalRank: metrics.meanReciprocalRank,
        precisionAtK: metrics.precisionAtK,
        falsePositiveRateAtK: metrics.falsePositiveRateAtK,
      }]
    })),
    averageQueryTokenCount: overall.averageQueryTokenCount,
    averageAdditionalQueryTokenCount: overall.averageAdditionalQueryTokenCount,
    averageRetrievalLatencyMs: overall.averageRetrievalLatencyMs,
  }
}

function createEvaluationCases(stratum: string, entries: ReadonlyArray<readonly [string, string, string]>): ReadonlyArray<Pick<MemoryEvaluationCase, 'id' | 'query' | 'relevantIds' | 'stratum'>> {
  return entries.map(([id, query, relevantId]) => ({ id, query, relevantIds: [relevantId], stratum }))
}

/** Small Chinese smoke judgments for the first real embedding run. */
export const CHINESE_MEMORY_EVALUATION_CASES: ReadonlyArray<Pick<MemoryEvaluationCase, 'id' | 'query' | 'relevantIds' | 'stratum'>> = Object.freeze([
  { id: 'scholarship', query: '我想申请奖学金，需要准备材料。', relevantIds: ['scholarship'], stratum: 'education' },
  { id: 'study-abroad', query: '我正在考虑出国留学的规划。', relevantIds: ['study-abroad'], stratum: 'education' },
  { id: 'startup', query: '我对创业没有兴趣，不想成为创业者。', relevantIds: ['startup'], stratum: 'career' },
  { id: 'work-avoidance', query: '我习惯通过工作和代码逃避现实压力。', relevantIds: ['work-avoidance'], stratum: 'emotion' },
  { id: 'appearance', query: '最近我换了发型和外观。', relevantIds: ['appearance'], stratum: 'appearance' },
])

/**
 * Stratified retrieval fixture for batches C–E of the memory plan.
 *
 * Each stratum has ten judgments. The fixture stores gold ids only; an
 * adapter supplies retrieved ids and optional cost or latency measurements.
 */
export const MEMORY_RETRIEVAL_EVALUATION_CASES: ReadonlyArray<Pick<MemoryEvaluationCase, 'id' | 'query' | 'relevantIds' | 'stratum'>> = Object.freeze([
  ...createEvaluationCases('short-zh', [
    ['short-zh-01', '奖学金材料怎么准备？', 'fact-scholarship'],
    ['short-zh-02', '我计划申请奖学金。', 'fact-scholarship'],
    ['short-zh-03', '我在考虑出国留学。', 'fact-study-abroad'],
    ['short-zh-04', '留学规划是我近期的目标。', 'fact-study-abroad'],
    ['short-zh-05', '我最近换了发型。', 'fact-appearance'],
    ['short-zh-06', '我的新外观已经改变。', 'fact-appearance'],
    ['short-zh-07', '我喜欢先跑测试。', 'fact-test-first'],
    ['short-zh-08', '接口修改前要看协议。', 'fact-protocol-first'],
    ['short-zh-09', '我习惯用代码处理压力。', 'fact-work-avoidance'],
    ['short-zh-10', '我不想成为创业者。', 'fact-no-startup'],
  ]),
  ...createEvaluationCases('long-zh', [
    ['long-zh-01', '我最近在考虑申请奖学金，也在整理课程和申请时间，希望先知道要准备哪些材料。', 'fact-scholarship'],
    ['long-zh-02', '因为之后可能要出国留学，我想把学校选择、语言考试和时间安排一起整理出来。', 'fact-study-abroad'],
    ['long-zh-03', '我换了新的发型和外观，之后聊天时请记住这个最近发生的变化。', 'fact-appearance'],
    ['long-zh-04', '我在修改接口以前想先阅读已有测试，避免协议和实现不一致。', 'fact-test-first'],
    ['long-zh-05', '如果需要调整接口，我希望先核对协议，再根据测试结果决定改动。', 'fact-protocol-first'],
    ['long-zh-06', '工作和代码有时让我暂时避开现实压力，这个模式最近又出现了。', 'fact-work-avoidance'],
    ['long-zh-07', '我对创业方向没有兴趣，即使有机会也不想把自己变成创业者。', 'fact-no-startup'],
    ['long-zh-08', '请从我过去提到的学习目标中找出和奖学金申请有关的事实。', 'fact-scholarship'],
    ['long-zh-09', '我想把留学计划和考试准备放在同一个时间表里查看。', 'fact-study-abroad'],
    ['long-zh-10', '以后讨论外观时，可以参考我最近更换发型这件事。', 'fact-appearance'],
  ]),
  ...createEvaluationCases('en-to-zh', [
    ['en-to-zh-01', 'What materials do I need for the scholarship application?', 'fact-scholarship'],
    ['en-to-zh-02', 'I am planning to study abroad.', 'fact-study-abroad'],
    ['en-to-zh-03', 'I recently changed my hairstyle.', 'fact-appearance'],
    ['en-to-zh-04', 'I prefer to run tests before changing an interface.', 'fact-test-first'],
    ['en-to-zh-05', 'Review the protocol before editing the API.', 'fact-protocol-first'],
    ['en-to-zh-06', 'I sometimes use work and code to avoid stress.', 'fact-work-avoidance'],
    ['en-to-zh-07', 'I do not want to become an entrepreneur.', 'fact-no-startup'],
    ['en-to-zh-08', 'Which fact mentions my scholarship goal?', 'fact-scholarship'],
    ['en-to-zh-09', 'Find my study abroad planning fact.', 'fact-study-abroad'],
    ['en-to-zh-10', 'Find the fact about my new appearance.', 'fact-appearance'],
  ]),
  ...createEvaluationCases('zh-to-en', [
    ['zh-to-en-01', '哪个事实说我需要准备奖学金材料？', 'fact-scholarship'],
    ['zh-to-en-02', '我关于出国留学的计划是什么？', 'fact-study-abroad'],
    ['zh-to-en-03', '我的外观发生了什么变化？', 'fact-appearance'],
    ['zh-to-en-04', '修改接口前我偏好先做什么？', 'fact-test-first'],
    ['zh-to-en-05', '修改 API 前我必须核对什么？', 'fact-protocol-first'],
    ['zh-to-en-06', '什么模式会帮助我回避压力？', 'fact-work-avoidance'],
    ['zh-to-en-07', '我拒绝哪一条职业路径？', 'fact-no-startup'],
    ['zh-to-en-08', '告诉我关于奖学金准备的记忆。', 'fact-scholarship'],
    ['zh-to-en-09', '告诉我关于出国留学规划的记忆。', 'fact-study-abroad'],
    ['zh-to-en-10', '告诉我关于新发型的记忆。', 'fact-appearance'],
  ]),
  ...createEvaluationCases('negation', [
    ['negation-01', '我不想申请创业项目。', 'fact-no-startup'],
    ['negation-02', '我没有出国留学的计划。', 'fact-no-study-abroad'],
    ['negation-03', '我不喜欢跳过测试直接改接口。', 'fact-test-first'],
    ['negation-04', '不要把我的发型记录成旧外观。', 'fact-appearance'],
    ['negation-05', '我避免用工作逃避压力。', 'fact-no-work-avoidance'],
    ['negation-06', '我不准备放弃奖学金申请。', 'fact-scholarship'],
    ['negation-07', '接口协议不能被忽略。', 'fact-protocol-first'],
    ['negation-08', '我没有创业兴趣。', 'fact-no-startup'],
    ['negation-09', '我不想删除留学规划。', 'fact-study-abroad'],
    ['negation-10', '请不要忘记我已经换了发型。', 'fact-appearance'],
  ]),
  ...createEvaluationCases('multi-fact', [
    ['multi-fact-01', '奖学金申请和出国留学都在我的学习计划中。', 'fact-scholarship'],
    ['multi-fact-02', '出国留学需要考试准备和时间规划。', 'fact-study-abroad'],
    ['multi-fact-03', '修改接口前看测试和协议是两个步骤。', 'fact-test-first'],
    ['multi-fact-04', '我换发型后仍然不喜欢创业方向。', 'fact-appearance'],
    ['multi-fact-05', '工作压力会让我使用代码回避现实。', 'fact-work-avoidance'],
    ['multi-fact-06', '奖学金材料属于留学准备的一部分。', 'fact-scholarship'],
    ['multi-fact-07', '协议核对和测试执行都发生在接口修改前。', 'fact-protocol-first'],
    ['multi-fact-08', '我的外观改变与学习计划没有关系。', 'fact-appearance'],
    ['multi-fact-09', '创业不是我的职业目标，学习才是。', 'fact-no-startup'],
    ['multi-fact-10', '我会先检查测试，再处理工作压力中的代码任务。', 'fact-test-first'],
  ]),
  ...createEvaluationCases('temporal', [
    ['temporal-01', '我现在需要准备奖学金材料。', 'fact-scholarship'],
    ['temporal-02', '我曾经计划出国留学。', 'fact-study-abroad'],
    ['temporal-03', '最近换发型是新的外观事实。', 'fact-appearance'],
    ['temporal-04', '以后修改接口仍然先跑测试。', 'fact-test-first'],
    ['temporal-05', '当前协议核对优先于接口实现。', 'fact-protocol-first'],
    ['temporal-06', '最近工作压力又让我想用代码回避。', 'fact-work-avoidance'],
    ['temporal-07', '目前创业仍然不是我的目标。', 'fact-no-startup'],
    ['temporal-08', '去年提到的奖学金目标现在还有效。', 'fact-scholarship'],
    ['temporal-09', '下个月开始准备留学考试。', 'fact-study-abroad'],
    ['temporal-10', '之前的发型已经不是当前外观。', 'fact-appearance'],
  ]),
  ...createEvaluationCases('unrelated-long', [
    ['unrelated-long-01', '天气预报说明天有雨，公交线路也会调整。', 'fact-unrelated-01'],
    ['unrelated-long-02', '我想读一本关于园艺和室内植物的书。', 'fact-unrelated-02'],
    ['unrelated-long-03', '晚餐需要买米饭、蔬菜和水果。', 'fact-unrelated-03'],
    ['unrelated-long-04', '这部电影的摄影风格和配乐都很特别。', 'fact-unrelated-04'],
    ['unrelated-long-05', '周末可以整理房间并清洗窗户。', 'fact-unrelated-05'],
    ['unrelated-long-06', '这条新闻讨论城市交通和公共设施。', 'fact-unrelated-06'],
    ['unrelated-long-07', '我需要给自行车轮胎充气并检查刹车。', 'fact-unrelated-07'],
    ['unrelated-long-08', '咖啡机的水箱需要在早上补满。', 'fact-unrelated-08'],
    ['unrelated-long-09', '猫粮快用完了，宠物用品店今天营业。', 'fact-unrelated-09'],
    ['unrelated-long-10', '桌面上的文件需要按日期分类。', 'fact-unrelated-10'],
  ]),
  ...createEvaluationCases('near-miss', [
    ['near-miss-01', '我想申请助学金而不是创业基金。', 'fact-scholarship'],
    ['near-miss-02', '我想短期旅行而不是出国留学。', 'fact-no-study-abroad'],
    ['near-miss-03', '我想看接口文档，但不准备修改接口。', 'fact-protocol-first'],
    ['near-miss-04', '朋友换了发型，不是我换了发型。', 'fact-no-appearance'],
    ['near-miss-05', '我用运动处理压力，不用工作和代码。', 'fact-no-work-avoidance'],
    ['near-miss-06', '我喜欢创业新闻，但不想成为创业者。', 'fact-no-startup'],
    ['near-miss-07', '奖学金截止日期和课程作业不是同一件事。', 'fact-scholarship'],
    ['near-miss-08', '留学城市的天气不是我的留学规划。', 'fact-study-abroad'],
    ['near-miss-09', '测试报告显示通过，但没有修改接口。', 'fact-test-first'],
    ['near-miss-10', '新的头像不是新的发型。', 'fact-no-appearance'],
  ]),
])
