import fs from 'fs';
import path from 'path';

export interface Example {
    id : string,
    utterance : string,
    sparql : string
}

/**
 * Preprocess one QALD example to extract only useful information for us
 * @param example An example in QALD
 * @returns A cleaned example object with id, utterance, and sparql
 */
export function preprocessExample(example : any) : Example {
    return {
        id: example.id,
        utterance: example.question[0].string,
        sparql: example.query.sparql
    };
}

/**
 * Preprocess all QALD train/test examples into a cleaned array
 * @returns An array of examples
 */
export function preprocessQALD(experiment : string) : Example[] {
    const trainQuestions = JSON.parse(fs.readFileSync(path.join(__dirname, `../../../data/${experiment}/train.json`), 'utf-8'));
    const testQuestions = JSON.parse(fs.readFileSync(path.join(__dirname, `../../../data/${experiment}/test.json`), 'utf-8'));
    const questions = [];
    for (const example of trainQuestions.questions) 
        questions.push(preprocessExample(example));
    for (const example of testQuestions.questions) 
        questions.push(preprocessExample(example));
    return questions;
}


/**
 * In some examples of QALD-7, an entity span is splitted into multiple keywords,
 * manually override them to recover 
 */
export const ENTITY_SPAN_OVERRIDE : Record<string, string> = {
    "Q11631": "cosmonauts", // astronaut
    "Q15180": "cosmonauts", // soviet union
    "Q159": "cosmonauts", // russia
    "Q5274359": "the first season of the HBO television series The Sopranos".toLowerCase(),
    "Q4970706": "federal chancellors of germany",
    "Q10800557": "actors"
};