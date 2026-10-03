/**
 * 內建預設 api_id / api_hash —— 讓使用者免去 my.telegram.org 申請步驟(原版即內建一組)。
 * 這裡用公開廣為流通的 Telegram Desktop 憑證;使用者可在「進階」自填覆蓋。
 * 注意:共用憑證理論上可能被 Telegram 限速,個人自用幾乎無感。
 */
export const DEFAULT_CREDENTIALS = {
  apiId: 2040,
  apiHash: 'b18441a1ff607e10a989891a5462e627'
}
