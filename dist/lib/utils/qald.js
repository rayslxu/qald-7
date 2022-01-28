"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENTITY_SPAN_OVERRIDE = exports.preprocessQALD = exports.preprocessExample = void 0;
const train_json_1 = __importDefault(require("../../data/train.json"));
const test_json_1 = __importDefault(require("../../data/test.json"));
/**
 * Preprocess one QALD example to extract only useful information for us
 * @param example An example in QALD
 * @returns A cleaned example object with id, utterance, and sparql
 */
function preprocessExample(example) {
    return {
        id: example.id,
        utterance: example.question[0].string,
        sparql: example.query.sparql
    };
}
exports.preprocessExample = preprocessExample;
/**
 * Preprocess all QALD train/test examples into a cleaned array
 * @returns An array of examples
 */
function preprocessQALD() {
    const questions = [];
    for (const example of train_json_1.default.questions)
        questions.push(preprocessExample(example));
    for (const example of test_json_1.default.questions)
        questions.push(preprocessExample(example));
    return questions;
}
exports.preprocessQALD = preprocessQALD;
/**
 * In some examples of QALD-7, an entity span is splitted into multiple keywords,
 * manually override them to recover
 */
exports.ENTITY_SPAN_OVERRIDE = {
    "Q5274359": "the first season of the HBO television series The Sopranos".toLowerCase(),
    "Q4970706": "federal chancellors of germany",
    "Q10800557": "actors"
};
//# sourceMappingURL=qald.js.map