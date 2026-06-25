use clap::{Parser, Subcommand};

mod bind;
mod chat;
mod schedule;
mod terminal_surface;

#[derive(Parser)]
#[command(name = "pico", version, about = "pico command-line interface")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Bind(bind::BindArgs),
    Chat(chat::ChatArgs),
    #[command(subcommand)]
    Schedule(schedule::ScheduleCommand),
}

#[tokio::main]
async fn main() -> color_eyre::Result<()> {
    color_eyre::install()?;
    let cli = Cli::parse();
    match cli.command {
        Command::Bind(args) => bind::run(args).await,
        Command::Chat(args) => chat::run(args).await,
        Command::Schedule(cmd) => schedule::run(cmd).await,
    }
}
