import WikidataUtils from '../utils/wikidata';
import AzureGPT3Wrapper from './wrapper';

export class GPT3Rephraser {
    private _wrapper : AzureGPT3Wrapper;
    private _wikidata : WikidataUtils;

    constructor(baseUrl : string, wikidata : WikidataUtils) {
        this._wrapper = new AzureGPT3Wrapper(baseUrl);
        this._wikidata = wikidata;
    }

    private async _retrieveProperties(entity : string) {
        const properties = await this._wikidata.getConnectedProperty(entity);
        const ttProperties : string[] = [];
        for (const property of properties) {
            const label = await this._wikidata.getLabel(property);
            ttProperties.push(label!);
        }
        return ttProperties;
    }

    private async _filterProperties(utterance : string, properties : string[]) {
        const batchSize = 20;
        const filtered : string[] = [];
        for (let i = 0; i < properties.length; i += batchSize) {
            const batch = properties.slice(i, i + batchSize);
            const prompt = this._filterPropertiesPrompt(utterance, batch);
            const result = await this._wrapper.complete(prompt);
            if (result && result !== 'none')
                filtered.push(...result.split(',').map((property) => property.trim()));
        }
        return [...new Set(filtered)];
    }

    private _filterPropertiesPrompt(utterance : string, properties : string[]) : string {
        const description = 'Given an utterance, choose all possible Wikidata properties ' +
            'required to retrieve answers from Wikidata. Be as inclusive as possible. ' + 
            'If no property is available, just say none.\n\n';
        const examples = 'Example:\n' +
            'Utterance: what religions are practiced in afghanistan ?\n' + 
            'Candidates: anthem, coat of arms image, basic form of government, religion or worldview, ' + 
            'contains administrative territorial entity, flag, ethnic group, legislative body, executive body, highest judicial authority\n' +
            'Properties: religion or worldview\n' +
            '\n\n' + 
            'Utterance: what religions are practiced in afghanistan ?\n' + 
            'Candidates: head of government, country, continent, currency, capital, official language, ' + 
            'head of state, shares border with, flag image, top-level Internet domain\n' +
            'Properties: none\n' + 
            '\n\n' + 
            'Utterance: What is the name of the world’s tallest building in dubai ?\n' + 
            'Candidates: head of government, image, country, capital, shares border with, flag image, ' + 
            'coat of arms image, located in the administrative territorial entity, height, twinned administrative body\n' + 
            'Properties: country, located in the administrative territorial entity, height\n' + 
            '\n\n';
        const question = 'Utterance: '  + utterance + 
            '\nCandidates: ' + properties.join(', ') +
            '\nProperties:';
        return description + examples + question;
    }

    private _rephrasePrompt(utterance : string, properties : string[]) : string {
        const description = 'You are chatting with a basic chatbot that answers questions based on Wikidata.' + 
            'Its language capability is limited. Please help rephrase the utterances such that it is easier for the chatbot to understand. ' +
            'Please paraphrase the utterance using the exact names from the property lists without changing the meaning.\n\n';
        const examples = 'Example:\n' +
            'Utterance: which countries border the us ?\n' + 
            'Properties: part of, inception, official name, official language, country, continent, owner of, shares border with, ethnic group\n' +
            'Paraphrase: which countries shares border with the us\n' +
            '\n\n' + 
            'Utterance: what is the name of the world’s tallest building in dubai ?\n' + 
            'Properties: named after, official name, height, located in the administrative territorial entity\n' + 
            'Paraphrase: what is the name of the building in dubai with the largest height ?\n' + 
            '\n\n';
        const question = 'Utterance: '  + utterance + 
            '\nProperties: ' + properties.join(', ') +
            '\nParaphrase:';
        return description + examples + question;
    }
    

    public async rephrase(utterance : string, entities : string[]) {
        const properties : string[] = [];
        for (const entity of entities) 
            properties.push(...(await this._retrieveProperties(entity)));
        const filteredProperties = await this._filterProperties(utterance, properties);
        const prompt = this._rephrasePrompt(utterance, filteredProperties);
        const result = await this._wrapper.complete(prompt);
        return result ?? utterance;
    }
}
