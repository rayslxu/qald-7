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
const fs = __importStar(require("fs"));
const fs_1 = require("fs");
const assert_1 = __importDefault(require("assert"));
const ThingTalk = __importStar(require("thingtalk"));
const genie_toolkit_1 = require("genie-toolkit");
const converter_1 = __importDefault(require("../lib/converter"));
async function main() {
    const manifest = await fs_1.promises.readFile('./manifest.tt', { encoding: 'utf8' });
    const library = ThingTalk.Syntax.parse(manifest, ThingTalk.Syntax.SyntaxType.Normal, { locale: undefined, timezone: undefined });
    (0, assert_1.default)(library instanceof ThingTalk.Ast.Library && library.classes.length === 1);
    const classDef = library.classes[0];
    const converter = new converter_1.default(classDef, { cache: 'wikidata_cache.sqlite', bootleg_db: 'bootleg.sqlite' });
    const tokenizer = new genie_toolkit_1.I18n.LanguagePack('en').getTokenizer();
    const tests = fs.readFileSync('./test/tests.txt').toString('utf-8').split('====');
    const index = parseInt(process.argv[2]);
    const start = index ? (index > 0 ? index - 1 : tests.length + index) : 0;
    for (let i = Math.max(start, 0); i < tests.length; i++) {
        console.log(`Running test ${i + 1} ...`);
        const utterance = tests[i].slice(tests[i].indexOf('Utterance:') + 'Utterance:'.length, tests[i].indexOf('SPARQL:')).trim();
        const sparql = tests[i].slice(tests[i].indexOf('SPARQL:') + 'SPARQL:'.length, tests[i].indexOf('TT:')).trim();
        const expected = tests[i].slice(tests[i].indexOf('TT:') + 'TT:'.length).trim();
        const preprocessed = tokenizer.tokenize(utterance).tokens.join(' ');
        const converted = await converter.convert(sparql, preprocessed);
        const thingtalk = genie_toolkit_1.ThingTalkUtils.serializePrediction(converted, preprocessed, genie_toolkit_1.EntityUtils.makeDummyEntities(preprocessed), { locale: 'en', timezone: undefined, includeEntityValue: true }).join(' ');
        assert_1.default.strictEqual(thingtalk, expected);
    }
}
main();
//# sourceMappingURL=index.js.map