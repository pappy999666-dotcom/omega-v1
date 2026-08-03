import readline from 'readline';

export class QuestionManager {
    private rl: readline.Interface;

    constructor() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }

    async ask(question: string, defaultValue: string = ''): Promise<string> {
        return new Promise((resolve) => {
            const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
            this.rl.question(prompt, (answer) => {
                resolve(answer.trim() || defaultValue);
            });
        });
    }

    async askWithValidation(
        question: string,
        validator: (input: string) => boolean | Promise<boolean>,
        errorMessage: string,
        defaultValue: string = ''
    ): Promise<string> {
        let answer: string;
        let isValid = false;
        while (!isValid) {
            answer = await this.ask(question, defaultValue);
            isValid = await validator(answer);
            if (!isValid) {
                console.log(`\x1b[31mError: ${errorMessage}\x1b[0m`);
            }
        }
        return answer!;
    }

    async select(question: string, options: string[]): Promise<string> {
        console.log(`\n${question}`);
        options.forEach((opt, index) => {
            console.log(`${index + 1}. ${opt}`);
        });
        
        const validator = (input: string) => {
            const num = parseInt(input);
            return !isNaN(num) && num >= 1 && num <= options.length;
        };

        const choice = await this.askWithValidation(
            `Choose an option (1-${options.length})`,
            validator,
            `Please enter a number between 1 and ${options.length}`
        );
        
        return options[parseInt(choice) - 1];
    }

    async confirm(question: string, defaultToYes: boolean = true): Promise<boolean> {
        const prompt = defaultToYes ? `${question} (Y/n)` : `${question} (y/N)`;
        const answer = await this.ask(prompt);
        if (answer === '') return defaultToYes;
        return answer.toLowerCase() === 'y';
    }

    close() {
        this.rl.close();
    }
}
