/**
 * Console plugin contract.
 *
 * An engine-layer extension (e.g. a game adapter) contributes panels to the owner
 * console as structured data. The console renders them generically; plugins never
 * ship scripts or HTML, and every action runs server-side under the instance lock.
 */

export type ConsoleValue = string | number | boolean | null

export interface ConsoleField {
    key: string
    label: string
    type: 'text' | 'number'
    required?: boolean
    placeholder?: string
}

export interface ConsoleAction {
    id: string
    label: string
    /** Fixed parameters sent back with the action (e.g. the row ID). */
    params?: Record<string, ConsoleValue>
    /** Inputs the owner fills in before running the action. */
    fields?: ConsoleField[]
    /** Confirmation prompt shown before running. */
    confirm?: string
    tone?: 'primary' | 'danger'
}

export type ConsoleSection =
    | { kind: 'fields'; title: string; items: Array<{ label: string; value: ConsoleValue }> }
    | { kind: 'table'; title: string; columns: Array<{ key: string; label: string }>;
        rows: Array<{ cells: Record<string, ConsoleValue>; actions?: ConsoleAction[] }>; empty?: string }
    | { kind: 'text'; title: string; text: string }
    | { kind: 'actions'; title: string; actions: ConsoleAction[] }

export interface ConsolePanel {
    id: string
    title: string
    /** Count shown next to the tab, e.g. pending approvals. */
    badge?: number
    sections: ConsoleSection[]
}

export interface ConsolePlugin {
    id: string
    title: string
    panels(): ConsolePanel[]
    /** Run an action; throw to report a refusal. Returns a short message for the owner. */
    act(actionId: string, params: Record<string, ConsoleValue>, actorId: string): { message: string }
}
