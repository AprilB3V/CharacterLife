/**
 * Season configuration for the Probably Stolen video cohost.
 *
 * Thresholds and word lists live here so they can be tuned without touching the
 * state machine. Numbers are compared by the adapter, never by the model.
 */
export interface SeasonConfig {
    /** Investigation progress that triggers `investigation_near_threshold`. */
    investigationNear: number
    /** Investigation progress that triggers `investigation_over_threshold`. */
    investigationOver: number
    /** Single-sale profit / price ratio that triggers `profit_margin_high`. */
    profitMarginHigh: number
    /** Item identifiers counted as chemical goods for `first_chem_sale`. */
    chemItemIds: string[]
    /** Achievement ID for beat B9a; null until confirmed from the game data. */
    sayMyNameAchievementId: string | null
    /** Story IDs regarded as faction-related for beat B8. */
    factionStoryIds: string[]
    /** Injected text must never contain these recipe-related terms. */
    recipeTerms: string[]
    /** How many closing memory candidates to propose at most. */
    maxClosingMemories: number
}

export const SEASON_CONFIG: SeasonConfig = {
    investigationNear: 75,
    investigationOver: 80,
    profitMarginHigh: 0.5,
    chemItemIds: ['dream_cap', 'dream_dust', 'nightmare', 'fanta', 'restricted_chemical'],
    sayMyNameAchievementId: null,
    factionStoryIds: ['cartel.first_visit', 'revolution.first_visit', 'church.first_visit'],
    recipeTerms: ['前体', '前驱体', '还原剂', '稳定剂', '催化剂', '试剂', '°C', '℃', '摄氏度', '温度', '反应时间', '提纯', '合成步骤'],
    maxClosingMemories: 5,
}

const REDACTED = '〔略〕'

/** Remove recipe-related terms from any text that is about to enter the model context. */
export function redactRecipeTerms(text: string, terms: readonly string[] = SEASON_CONFIG.recipeTerms): string {
    let result = text
    for (const term of terms) if (term) result = result.split(term).join(REDACTED)
    return result
}

/** Return the recipe-related terms found in a text; used by tests and audits. */
export function findRecipeTerms(text: string, terms: readonly string[] = SEASON_CONFIG.recipeTerms): string[] {
    return terms.filter(term => term && text.includes(term))
}
