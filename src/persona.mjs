// Match the game's PersonaResolver/OutfitCatalog rules; object order is not active state.
const outfitCards = {
  outfit13: 'sister-dilei', outfit14: 'sister-kindergarten', outfit15: 'sister-tutor',
  outfit16: 'sister-low', outfit17: 'sister-medium', outfit18: 'sister-verylow', outfit19: 'sister-null'
};
const fields = ['name', 'description', 'personality', 'scenario', 'creator_notes', 'mes_example', 'first_mes', 'alternate_greetings'];
function cardData(card) {
  const d = card?.data || card;
  return d && typeof d === 'object' && fields.some(k => typeof d[k] === 'string' && d[k].trim()) ? d : null;
}
function cardsFor(slot) {
  return Object.entries(slot.save?.data?.prompts || {}).flatMap(([key, card]) => {
    const data = cardData(card); return data ? [{ key, data }] : [];
  });
}
export function personaChoices(slot) {
  return cardsFor(slot).map(({ key, data }) => ({ key, name: typeof data.name === 'string' ? data.name : '' }));
}
export function validatePersonaKey(slot, key) {
  if (key != null && (typeof key !== 'string' || (key && !personaChoices(slot).some(c => c.key === key)))) throw new Error('所选人设卡不在此存档中');
}
export function resolvePersona(slot) {
  if (slot.persona?.trim()) return { key: null, source: 'override', reason: '桌面人设覆盖', text: slot.persona.trim() };
  const cards = cardsFor(slot);
  const select = (key, source, reason) => {
    const card = cards.find(c => c.key === key);
    if (!card) return { key, source, reason, text: '', error: `存档当前应使用 ${key}，但导出文件未包含此卡。请在人设设置中手动选择或填写覆盖。` };
    const text = fields.filter(k => card.data[k]).map(k => `${k}: ${typeof card.data[k] === 'string' ? card.data[k] : JSON.stringify(card.data[k])}`).join('\n');
    return { key, source, reason, text };
  };
  if (slot.personaKey) return select(slot.personaKey, 'manual', '桌面手动选择');
  const game = slot.save?.data?.gameData || {}, character = game.characterSystemData || {};
  // A selected UGC pack must not silently fall back to a built-in character.
  if (character.currentPersonaPackId) return select(character.currentPersonaPackId, 'pack', '存档选中的人设包');
  if (!cards.length) return { key: null, source: 'empty', reason: '尚未设置人设', text: '自然地与用户聊天；尚未指定角色身份，由用户之后提供设定。' };
  const outfit = game.currentOutfit;
  const outfitKey = outfit === 'outfit20' ? (character.kemonomimiCatForm ? 'sister-kemonomimi-cat' : 'sister-kemonomimi') : outfitCards[outfit];
  if (outfitKey) return select(outfitKey, 'outfit', `存档服装 ${outfit}`);
  const affection = character.stats?.affection ?? game.characterStats?.affection;
  if (affection !== null && affection !== undefined && affection !== '' && Number.isFinite(Number(affection))) {
    const value = Number(affection), key = value < -30 ? 'sister-verylow' : value < 30 ? 'sister-low' : value < 70 ? 'sister-medium' : 'sister-high';
    return select(key, 'affection', `存档好感度 ${value}`);
  }
  if (cards.length === 1) return select(cards[0].key, 'single', '存档仅有一张人设卡');
  return { key: null, source: 'unresolved', reason: '存档缺少当前人设状态', text: '', error: '存档有多张人设卡，但缺少可判断当前角色的状态。请在人设设置中手动选择。' };
}
