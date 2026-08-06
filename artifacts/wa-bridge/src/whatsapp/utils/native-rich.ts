// ============================================================
// WA-Bridge — Native Rich Components
//
// Builders for the native rich interactive components provided
// by @crysnovax/baileys 2.7.0. Every payload below is verified
// against the installed fork source:
//
//  • Native TABLE → richResponseMessage containing a
//    GenATableUXPrimitive, built by prepareRichResponseMessage()
//    in lib/Utils/rich-message-utils.js and wrapped in a
//    botForwardedMessage. The first row is the header.
//    (generateWAMessageContent — "table" branch. VERIFIED.)
//
//  • Native interactive list → a `single_select` native-flow
//    button (bottom sheet with selectable rows). Prepared by
//    prepareNativeFlowButtons() from a `{ text, sections }`
//    button. Selecting a row arrives back as
//    interactiveResponseMessage.nativeFlowResponseMessage.paramsJson
//    carrying the row id — routed by the Central Interaction
//    Router. (VERIFIED — the fork's `sections` → listMessage
//    branch is unreachable: any non-media payload falls into the
//    catch-all prepareWAMessageMedia() and throws "Invalid media
//    type", so listMessage is NOT serializable in this fork.)
//
// Nothing here fakes UI with ASCII — these are the exact content
// objects the fork's generateWAMessageContent() serializes.
// ============================================================

export interface NativeListRow {
  title: string;
  description?: string;
  rowId: string;
}

export interface NativeListSection {
  title?: string;
  rows: NativeListRow[];
}

export interface NativeTableContent {
  title?: string;
  rows: (string | number)[][];
}

/**
 * Baileys richResponseMessage table content.
 *
 * `noDonation` suppresses the fork's default crysnovax donation link and
 * `links: []` keeps the source-citation list empty so the table renders
 * cleanly without external branding.
 */
export function nativeTableContent(table: NativeTableContent): Record<string, unknown> {
  const content: Record<string, unknown> = {
    table: table.rows,
    noDonation: true,
    links: [],
  };
  if (table.title) content.title = table.title;
  return content;
}

/**
 * Pre-formatted `single_select` native-flow button (the fork's
 * prepareNativeFlowButtons() passes `{ name, buttonParamsJson }` through
 * verbatim, so the sheet renders exactly as specified).
 */
export function singleSelectButton(
  title: string,
  sections: NativeListSection[]
): { name: string; buttonParamsJson: string } {
  return {
    name: 'single_select',
    buttonParamsJson: JSON.stringify({ title, sections }),
  };
}

/** Compact ping metrics rendered as the native table. */
export function pingTableData(
  sessionId: string,
  status: string,
  opts: { latencyMs: number; runtime: string; ram: string; platform: string; version: string }
): NativeTableContent {
  return {
    title: '⚡ CORE STATUS',
    rows: [
      ['Metric', 'Value'],
      ['Latency', `${opts.latencyMs} ms`],
      ['Session', sessionId],
      ['Runtime', opts.runtime],
      ['Memory', opts.ram],
      ['Platform', opts.platform],
      ['Version', opts.version],
      ['Status', status],
    ],
  };
}
