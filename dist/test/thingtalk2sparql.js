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
const assert_1 = __importDefault(require("assert"));
const Tp = __importStar(require("thingpedia"));
const ThingTalk = __importStar(require("thingtalk"));
const converter_1 = require("../lib/converter");
const wikidata_1 = require("../lib/utils/wikidata");
const entities = JSON.parse(fs.readFileSync('./domain.json', { encoding: 'utf8' })).data;
async function main() {
    const tpClient = new Tp.FileClient({ thingpedia: './manifest.tt', locale: 'en' });
    const schemas = new ThingTalk.SchemaRetriever(tpClient, null, true);
    const classDef = await schemas.getFullMeta(wikidata_1.TP_DEVICE_NAME);
    const options = {
        locale: 'en-US',
        timezone: undefined,
        cache: 'wikidata_cache.sqlite',
        bootleg: 'bootleg.sqlite'
    };
    const converter = new converter_1.ThingTalkToSPARQLConverter(classDef, entities, options);
    const tests = fs.readFileSync('./test/tests-reverse.txt').toString('utf-8').split('====');
    const index = parseInt(process.argv[2]);
    const start = index ? (index > 0 ? index - 1 : tests.length + index) : 0;
    for (let i = Math.max(start, 0); i < tests.length; i++) {
        console.log(`Running test ${i + 1} ...`);
        const utterance = tests[i].slice(tests[i].indexOf('Utterance:') + 'Utterance:'.length, tests[i].indexOf('SPARQL:')).trim();
        const expected = tests[i].slice(tests[i].indexOf('SPARQL:') + 'SPARQL:'.length, tests[i].indexOf('TT:')).trim();
        const thingtalk = tests[i].slice(tests[i].indexOf('TT:') + 'TT:'.length).trim();
        const sparql = await converter.convert(utterance, thingtalk);
        assert_1.default.strictEqual(sparql, expected.replace(/\s+/g, ' '));
    }
}
main();
//# sourceMappingURL=thingtalk2sparql.js.map