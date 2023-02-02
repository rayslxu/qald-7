import WikidataUtils from '../utils/wikidata';
import AzureGPT3Wrapper from './wrapper';
import { RephrasePromptGenerator } from './prompt/rephrase';

export class GPT3Rephraser {
    private _wrapper : AzureGPT3Wrapper;
    private _prompter : RephrasePromptGenerator;

    constructor(baseUrl : string, wikidata : WikidataUtils) {
        this._wrapper = new AzureGPT3Wrapper(baseUrl);
        this._prompter = new RephrasePromptGenerator(wikidata);
    }

    private async _prompt(utterance : string, entities : string[]) : Promise<string> {
        const description = 'You are talking to a question answering system based on Wikidata ' + 
            'and its natural language capability is limited. Please rephrase the utterance by ' +
            'using the exact names from the given properties.\n';
        const example = 'Example:\n' +
            'Utterance: which countries border the us ?\n' + 
            'Properties: part of, inception, official name, official language, country, continent, owner of, shares border with, ethnic group\n' +
            'Rephrase: which countries shares border with the us\n';
        const question = await this._prompter.prompt(utterance, entities);
        return description + example + question;
    }

    public async rephrase(utterance : string, entities : string[]) {
        const prompt = await this._prompt(utterance, entities);
        console.log(prompt);
        const result = await this._wrapper.complete(prompt);
        return result ?? utterance;
    }
}