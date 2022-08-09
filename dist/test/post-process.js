"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const Tp = __importStar(require("thingpedia"));
const ThingTalk = __importStar(require("thingtalk"));
const post_processor_1 = require("../lib/post-processor");
const wikidata_1 = require("../lib/utils/wikidata");
const TEST_CASES = [
    [
        'how many countries are there in europe ?',
        `count ( @${wikidata_1.TP_DEVICE_NAME} . country ( ) filter contains ( continent , " Q46 " ^^${wikidata_1.TP_DEVICE_NAME}:p_continent ) ) ;`,
        `count ( @${wikidata_1.TP_DEVICE_NAME} . entity ( ) filter contains ( continent , " Q46 " ^^${wikidata_1.TP_DEVICE_NAME}:entity ) && instance_of == " country " ^^${wikidata_1.TP_DEVICE_NAME}:domain ) ;`
    ],
    [
        'how many people live in the capital of Australia?',
        `[ population ] of @${wikidata_1.TP_DEVICE_NAME} . entity ( ) filter in_array ( id , any ( [ capital ] of @${wikidata_1.TP_DEVICE_NAME} . country ( ) filter id == " Q408 " ^^${wikidata_1.TP_DEVICE_NAME}:country ) ) ;`,
        `[ population ] of @${wikidata_1.TP_DEVICE_NAME} . entity ( ) filter in_array ( id , any ( [ capital ] of @${wikidata_1.TP_DEVICE_NAME} . entity ( ) filter id == " Q408 " ^^${wikidata_1.TP_DEVICE_NAME}:entity ) ) ;`
    ],
    [
        'Give me the birthdays of all actors of the television show Charmed',
        `[ < cast_member / date_of_birth > ] of @${wikidata_1.TP_DEVICE_NAME} . television_series ( ) filter id == " Q162371 " ^^${wikidata_1.TP_DEVICE_NAME}:television_series ;`,
        `[ < cast_member / date_of_birth > ] of @${wikidata_1.TP_DEVICE_NAME} . entity ( ) filter id == " Q162371 " ^^${wikidata_1.TP_DEVICE_NAME}:entity ;`
    ]
];
async function main() {
    const tpClient = new Tp.FileClient({ thingpedia: './manifest.tt', locale: 'en' });
    const schemas = new ThingTalk.SchemaRetriever(tpClient, null, true);
    const processor = new post_processor_1.PostProcessor({
        tpClient,
        schemas,
        class: await schemas.getFullMeta(wikidata_1.TP_DEVICE_NAME),
        normalizeDomains: 'always',
        normalizeEntityTypes: true,
        includeEntityValue: true,
        excludeEntityDisplay: true
    });
    for (const [utterance, before, after] of TEST_CASES) {
        const processed = await processor.postprocess(before, utterance);
        assert_1.default.strictEqual(processed.join(' '), after);
    }
}
main();
//# sourceMappingURL=post-process.js.map