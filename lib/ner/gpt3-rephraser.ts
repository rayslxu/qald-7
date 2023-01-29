import * as Tp from 'thingpedia';
import WikidataUtils from '../utils/wikidata';

export class GPT3Rephraser {
    private _url : string;
    private _wikidata : WikidataUtils;

    constructor(baseUrl : string, wikidata : WikidataUtils) {
        this._url = `${baseUrl}/openai/deployments/text/completions?api-version=2022-12-01`;
        this._wikidata = wikidata;
    }

    private _prompt(utterance : string, properties : string[]) : string {
        const description = 'You are talking to a question answering system based on Wikidata ' + 
            'and its natural language capability is limited. Please rephrase the utterance by ' +
            'using the exact names from the given properties.\n';
        const example = 'Example:\n' +
            'Utterance: which countries border the us ?\n' + 
            'Properties: part of, inception, official name, official language, country, continent, owner of, shares border with, ethnic group\n' +
            'Rephrase: which countries shares border with the us\n';
        const question = `Utterance: ${utterance} \n` +
            `Properties: ${properties.join(', ')}\n` +
            `Rephrase:`;
        return description + example + question;
    }

    public async rephrase(utterance : string, entities : string[]) {
        const properties = [];
        for (const entity of entities) {
            const pids = await this._wikidata.getConnectedProperty(entity);
            for (const pid of pids) {
                const label = await this._wikidata.getLabel(pid);
                if (label)
                    properties.push(label);
            }
        }
        const prompt = this._prompt(utterance, properties);
        console.log(prompt);
        const raw = await Tp.Helpers.Http.post(this._url, JSON.stringify({ prompt }), {
            dataContentType: 'application/json',
            extraHeaders: { 'api-key': process.env.OPENAI_API_KEY as string }
        });
        const res = JSON.parse(raw);
        if (res.choices.length > 0)
            return res.choices[0].text.trim();
        return utterance;
    }
}