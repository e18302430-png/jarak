// صور المنتجات: أيقونات ثلاثية الأبعاد من Microsoft Fluent Emoji (رخصة MIT)
// لما تصوّر منتجاتك الحقيقية، ارفعها في public/img/p وغيّر الاسم هنا أو من قاعدة البيانات (products.image)
const RULES = [
  [/حليب|لبن المراعي/, 'glass_of_milk'], [/زبادي/, 'bowl_with_spoon'], [/جبنة/, 'cheese_wedge'], [/لبنة|مايونيز|سمن/, 'jar'],
  [/بيض/, 'egg'], [/زبدة/, 'butter'], [/^ماء/, 'droplet'], [/بيبسي|كوكا|سفن|ريد/, 'cup_with_straw'], [/عصير/, 'beverage_box'],
  [/شاي/, 'teacup_without_handle'], [/نسكافيه/, 'hot_beverage'], [/قهوة/, 'teapot'], [/صامولي/, 'baguette_bread'], [/توست/, 'bread'],
  [/خبز عربي|تميس/, 'flatbread'], [/كرواسون/, 'croissant'], [/^رز/, 'cooked_rice'], [/سكر/, 'rock'], [/دقيق/, 'sheaf_of_rice'],
  [/عدس|حمص|فول/, 'beans'], [/مكرونة|شعيرية/, 'spaghetti'], [/إندومي/, 'steaming_bowl'], [/زيت/, 'olive'], [/صلصة|تونة/, 'canned_food'],
  [/كاتشب|طماطم/, 'tomato'], [/عسل/, 'honey_pot'], [/تمر/, 'chestnut'], [/دجاج/, 'poultry_leg'], [/برجر/, 'hamburger'],
  [/مقلية/, 'french_fries'], [/آيسكريم/, 'soft_ice_cream'], [/ليز/, 'pretzel'], [/شوكولاتة|كيت كات/, 'chocolate_bar'], [/بسكويت/, 'cookie'],
  [/فشار/, 'popcorn'], [/علكة/, 'candy'], [/بصل/, 'onion'], [/^بطاطس$/, 'potato'], [/خيار/, 'cucumber'], [/ليمون/, 'lemon'], [/موز/, 'banana'],
  [/تفاح/, 'red_apple'], [/بقدونس/, 'herb'], [/تايد/, 'bubbles'], [/فيري/, 'sponge'], [/كلوركس|شامبو/, 'lotion_bottle'], [/مناديل|ورق حمام/, 'roll_of_paper'],
  [/زبالة/, 'wastebasket'], [/صابون/, 'soap'], [/معجون/, 'toothbrush'], [/حفاضات/, 'baby_bottle'], [/فحم/, 'fire'], [/ثلج/, 'ice'], [/أكواب/, 'cup_with_straw']
];
export const CAT_IMG = { 'ألبان': 'glass_of_milk', 'مخبوزات': 'bread', 'مشروبات': 'cup_with_straw', 'أرز وبقوليات': 'cooked_rice', 'زيوت': 'olive', 'معلبات': 'canned_food', 'مجمدات': 'ice', 'خضار وفواكه': 'red_apple', 'سناكات': 'popcorn', 'منظفات': 'bubbles', 'عناية شخصية': 'soap', 'أخرى': 'package' };
// صور حقيقية للعلب (Open Food Facts، رخصة CC BY-SA). المفتاح: الاسم|الحجم
import { readFileSync } from 'node:fs';
export const PHOTOS = JSON.parse(readFileSync(new URL('./photos.json', import.meta.url), 'utf8'));
export function imageFor(name, category, size) {
  if (PHOTOS[name + '|' + (size || '')]) return PHOTOS[name + '|' + (size || '')];
  const hit = RULES.find(([re]) => re.test(name));
  return '/img/p/' + (hit ? hit[1] : CAT_IMG[category] || 'shopping_cart') + '.webp';
}
