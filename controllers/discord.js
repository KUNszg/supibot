module.exports = class Discord extends require("./template.js") {
	constructor () {
		super();

		this.platform = sb.Platform.get("discord");
		if (!this.platform) {
			throw new sb.Error({
				message: "Discord platform has not been created"
			});
		}
		else if (!this.platform.Self_ID) {
			throw new sb.Error({
				message: "Discord user ID has not been configured"
			});
		}
		else if (!sb.Config.has("DISCORD_BOT_TOKEN", true)) {
			throw new sb.Error({
				message: "Discord bot token has not been configured"
			});
		}

		this.client = new (require("discord.js")).Client();

		this.initListeners();

		this.client.login(sb.Config.get("DISCORD_BOT_TOKEN"));
	}

	initListeners () {
		const client = this.client;

		client.on("ready", async () => {
			const active = client.channels.cache.filter(i => i.type === "text");
			const joinable = sb.Channel.getJoinableForPlatform("discord");

			for (const channel of joinable) {
				const exists = active.find(i => i.id === channel.Name);
				if (!exists) {
					channel.Mode = "Inactive";
					await channel.saveProperty("Mode", channel.Mode);
					console.debug("Discord channel set as inactive", channel);
				}
			}
		});

		client.on("message", async (messageObject) => {
			const {
				commandArguments,
				chan,
				discordID,
				guild,
				msg,
				mentions,
				privateMessage,
				user
			} = this.parseMessage(messageObject);

			let channelData = null;
			let userData = await sb.User.getByProperty("Discord_ID", discordID);

			// If no user with the given Discord ID exists, check and see if the name is already being used
			if (!userData) {
				const nameCheckData = await sb.User.get(user, true);

				// If it is, skip entirely - the name must be matched precisely to the Discord ID, and this is an anomaly
				// Needs to be fixed or flagged manually
				if (nameCheckData && nameCheckData.Discord_ID === null && nameCheckData.Twitch_ID !== null) {
					if (
						(nameCheckData.Data.discordChallengeNotificationSent)
						|| (!this.platform.Data.sendVerificationChallenge)
						|| (!msg.startsWith(sb.Command.prefix))
					) {
						return;
					}

					const { challenge } = await Discord.createAccountChallenge(nameCheckData, discordID);
					nameCheckData.Data.discordChallengeNotificationSent = true;
					await nameCheckData.saveProperty("Data");

					await this.directPm(
						discordID,
						sb.Utils.tag.trim `
							You were found to be likely to own a Twitch account with the same name as your current Discord account.
							If you want to use my commands on Discord, whisper me the following command on Twitch:
							${sb.Command.prefix}link ${challenge}
						 `
					);

					return;
				}
				// Otherwise, set up the user with their Discord ID
				else {
					userData = await sb.User.add(user);
					await userData.saveProperty("Discord_ID", discordID);
				}
			}

			if (!privateMessage) {
				channelData = sb.Channel.get(chan);
				if (!channelData) {
					channelData = await sb.Channel.add(chan, this.platform);
					await channelData.setup();
				}

				// If a message comes from a channel set as "Inactive", this means it is active again.
				// Change its mode back to active.
				if (channelData.Mode === "Inactive") {
					channelData.Mode = "Write";
					await channelData.saveProperty("Mode", channelData.Mode);
				}

				const channelDescription = guild.name + " - #" + messageObject.channel.name;
				if (channelData.Description !== channelDescription) {
					await channelData.saveProperty("Description", channelDescription);
				}

				if (channelData.NSFW !== messageObject.channel.nsfw) {
					await channelData.saveProperty("NSFW", messageObject.channel.nsfw);
				}

				sb.Logger.push(msg, userData, channelData);

				if (channelData.Mode !== "Read") {
					sb.AwayFromKeyboard.checkActive(userData, channelData);
					sb.Reminder.checkActive(userData, channelData);
				}

				// Mirroring is set up - mirror the message to the target channel
				if (channelData.Mirror) {
					this.mirror(msg, userData, channelData);
				}
			}

			if (channelData && channelData.Mode === "Read") {
				return;
			}

			// Own message - skip
			if (discordID === this.platform.Self_ID) {
				return;
			}

			sb.Master.globalMessageListener(this.platform, channelData, userData, msg);

			// Starts with correct prefix - handle command
			if (sb.Command.is(msg)) {
				const commandPrefix = sb.Command.prefix;
				const [command] = msg.replace(commandPrefix, "").split(" ").filter(Boolean);

				this.handleCommand(
					command,
					commandArguments.slice(1).map(i => Discord.removeEmoteTags(i)),
					channelData,
					userData,
					{
						mentions,
						guild,
						privateMessage
					}
				);
			}
		});

		client.on("error", (err) => {
			console.error(err);
			this.restart();
		});
	}

	/**
	 * Sends a message
	 * @param message
	 * @param channel
	 */
	async send (message, channel) {
		const channelData = sb.Channel.get(channel).Name;
		const channelObject = this.client.channels.cache.get(channelData);
		if (!channelObject) {
			console.warn("No channel available!", channel);
			return;
		}

		if (channelObject.guild) {
			const wordList = message.split(/\W+/).filter(Boolean);
			for (const word of wordList) {
				const emote = channelObject.guild.emojis.cache.find(i => i.name === word);
				if (emote) {
					// This regex makes sure all emotes to be replaces are not preceded or followed by a ":" (colon) character
					// All emotes on Discord are wrapped at least by colons
					const regex = new RegExp("(?<!(:))\\b" + emote.name + "\\b(?!(:))", "g");
					message = message.replace(regex, emote.toString());
				}
			}

			const mentionedUsers = await Discord.getMentionsInMessage(message);
			for (const user of mentionedUsers) {
				if (user.Discord_ID) {
					const regex = new RegExp("@" + user.Name, "gi");
					message = message.replace(regex, "<@" + user.Discord_ID + ">");
				}
			}
		}

		channelObject.send(sb.Utils.wrapString(message, channelData.Message_Limit ?? this.platform.Message_Limit));
	}

	/**
	 * Sends a private message.
	 * The user in question must have their Discord ID filled out, otherwise the method fails.
	 * @param {User|string|number} user
	 * @param {string} msg
	 * @returns {Promise<void>}
	 * @throws {sb.Error} If the provided user does not exist
	 * @throws {sb.Error} If the provided user has no Discord ID connected.
	 */
	async pm (user, msg) {
		const userData = await sb.User.get(user, true);
		if (!userData.Discord_ID) {
			throw new sb.Error({
				message: `Discord PM attempt: User ${userData.Name} has no Discord ID`
			});
		}

		const discordUser = await this.client.users.fetch(userData.Discord_ID);
		discordUser.send(msg);
	}

	/**
	 * Directly sends a private message to user, without them necessarily being saved as a user.
	 * @param {string} userID
	 * @param {string }msg
	 * @returns {Promise<void>}
	 */
	async directPm (userID, msg) {
		const discordUser = await this.client.users.fetch(userID);
		discordUser.send(msg);
	}

	/**
	 * Handles command execution.
	 * @param {string} command Command invocation string
	 * @param {User} userData
	 * @param {Channel} channelData
	 * @param {Array} args
	 * @param {Object} options = {}
	 * @returns {Promise<void>}
	 */
	async handleCommand (command, args, channelData, userData, options = {}) {
		const execution = await sb.Command.checkAndExecute(command, args, channelData, userData, {
			platform: this.platform,
			...options
		});

		if (!execution || !execution.reply) {
			return;
		}

		if (channelData?.Mirror) {
			this.mirror(execution.reply, userData,channelData, true);
		}

		if (options.privateMessage || execution.replyWithPrivateMessage) {
			const message = await sb.Master.prepareMessage(execution.reply, null, {
				platform: this.platform
			});

			this.pm(userData, message);
		}
		else {
			const message = await sb.Master.prepareMessage(execution.reply, channelData, { skipBanphrases: true });
			this.send(message, channelData);
		}
	}

	destroy () {
		this.client && this.client.destroy();
		this.client = null;
	}

	restart () {
		sb.Master.reloadClientModule(this.platform, false);
		this.destroy();
	}

	parseMessage (messageObject) {
		const args = messageObject.content.split(" ");
		for (let i = 0; i < args.length; i++) {
			const match = args[i].match(/<@!(\d+)>/);
			if (match) {
				const user = messageObject.mentions.users.get(match[1]);
				if (user) {
					args[i] = "@" + user.username;
				}
			}
		}

		let index = 0;
		const links = messageObject.attachments.map(i => i.proxyURL);
		let targetMessage = messageObject.cleanContent.replace(/\n/g, " ");
		while (targetMessage.length < this.platform.Message_Limit && index < links.length) {
			targetMessage += " " + links[index];
			index++;
		}

		return {
			msg: Discord.removeEmoteTags(targetMessage.replace(/\s+/g, " ")),
			user: messageObject.author.username.toLowerCase().replace(/\s/g, "_"),
			chan: messageObject.channel.id,
			channelType: messageObject.channel.type,
			discordID: String(messageObject.author.id),
			author: messageObject.author,
			mentions: messageObject.mentions,
			guild: messageObject?.channel?.guild ?? null,
			privateMessage: Boolean(messageObject.channel.type === "dm"),
			commandArguments: args
		};
	}

	static removeEmoteTags (message) {
		return message.replace(/<a?:(.*?):(\d*)>/g, (total, emote) => emote + " ").trim();
	}

	static async createAccountChallenge (userData, discordID) {
		const row = await sb.Query.getRow("chat_data", "User_Verification_Challenge");
		const challenge = require("crypto").randomBytes(16).toString("hex");

		row.setValues({
			User_Alias: userData.ID,
			Specific_ID: discordID,
			Challenge: challenge,
			Platform_From: sb.Platform.get("discord").ID,
			Platform_To: sb.Platform.get("twitch").ID
		});

		await row.save();
		return {
			challenge
		};
	}

	static async getMentionsInMessage (message) {
		return (await Promise.all(
			message.replace(/^.*?@/, "@")
				.replace(/\s+/g, "_")
				.split(/[^@\w]/)
				.filter(i => i.startsWith("@") || i.startsWith("_@"))
				.map(i => i.replace(/^_|_$/g, ""))
				.filter(Boolean)
				.flatMap(i => {
					const names = [];
					let name = "";
					i.split("_").forEach(i => {
						if (name) {
							name += "_";
						}
						name += i;
						names.push(name);
					});

					return names;
				})
				.map(user => sb.User.get(user))
		)).filter(Boolean);
	}

};